# nodejs-cicd-demo — Full AWS CI/CD to ECS (Fargate)

A small Express app used as the payload for a real, end-to-end AWS CI/CD pipeline:

```
GitHub  ->  CI (GitHub Actions or Jenkins)  ->  npm test  ->  Docker build
  ->  push to Amazon ECR  ->  register ECS task definition  ->  update ECS service (Fargate)
  ->  traffic via Application Load Balancer  ->  logs in CloudWatch
```

No Terraform here — everything below is provisioned with the AWS CLI/console so you can see
and understand every resource being created.

---

## 1. The application

- `src/app.js` — Express app with:
  - `GET /healthz` — liveness probe
  - `GET /readyz` — readiness probe
  - `GET /api/info` — service/version/hostname info
  - `GET /api/items` — sample JSON data
  - `GET /metrics` — Prometheus-format metrics (scrape target for CloudWatch Container Insights / a self-hosted Prometheus)
- `test/app.test.js` — Jest + Supertest tests (run in CI before anything is deployed)
- `Dockerfile` — multi-stage, non-root, ~120MB final image, has a container `HEALTHCHECK`

Run it locally:

```bash
npm install
npm test
npm start
curl localhost:3000/api/info
```

Build and run the container locally:

```bash
docker build -t nodejs-cicd-demo:local .
docker run -p 3000:3000 nodejs-cicd-demo:local
```

---

## 2. One-time AWS setup (do this first, manually)

Set some shell variables you'll reuse:

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export REPO_NAME=nodejs-cicd-demo
export CLUSTER_NAME=nodejs-cicd-demo-cluster
export SERVICE_NAME=nodejs-cicd-demo-service
```

### 2.1 Create the ECR repository

```bash
aws ecr create-repository \
  --repository-name $REPO_NAME \
  --image-scanning-configuration scanOnPush=true \
  --region $AWS_REGION
```

### 2.2 Push the first image manually (so the ECS service has something to pull on creation)

```bash
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

docker build --build-arg APP_VERSION=init -t $REPO_NAME:init .
docker tag $REPO_NAME:init $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$REPO_NAME:init
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$REPO_NAME:init
```

### 2.3 Networking (or reuse your default VPC)

```bash
export VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
export SUBNET_IDS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC_ID --query 'Subnets[].SubnetId' --output text | tr '\t' ',')
```

### 2.4 Security group for the app (allow 3000 from the ALB only, in a real setup)

```bash
export SG_ID=$(aws ec2 create-security-group \
  --group-name nodejs-cicd-demo-sg \
  --description "nodejs-cicd-demo tasks" \
  --vpc-id $VPC_ID --query GroupId --output text)

aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID --protocol tcp --port 3000 --cidr 0.0.0.0/0   # tighten to the ALB SG in production
```

### 2.5 Application Load Balancer + target group

```bash
export ALB_ARN=$(aws elbv2 create-load-balancer \
  --name nodejs-cicd-demo-alb \
  --subnets $(echo $SUBNET_IDS | tr ',' ' ') \
  --security-groups $SG_ID \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)

export TG_ARN=$(aws elbv2 create-target-group \
  --name nodejs-cicd-demo-tg \
  --protocol HTTP --port 3000 --vpc-id $VPC_ID \
  --target-type ip \
  --health-check-path /healthz \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

aws elbv2 create-listener \
  --load-balancer-arn $ALB_ARN \
  --protocol HTTP --port 80 \
  --default-actions Type=forward,TargetGroupArn=$TG_ARN
```

### 2.6 IAM roles (execution role pulls the image + writes logs; task role is for the app's own AWS calls)

```bash
aws iam create-role --role-name nodejs-cicd-demo-execution-role \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

aws iam attach-role-policy --role-name nodejs-cicd-demo-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

aws iam create-role --role-name nodejs-cicd-demo-task-role \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
```

### 2.7 CloudWatch log group

```bash
aws logs create-log-group --log-group-name /ecs/nodejs-cicd-demo --region $AWS_REGION
```

### 2.8 ECS cluster (Fargate)

```bash
aws ecs create-cluster --cluster-name $CLUSTER_NAME
```

### 2.9 Register the first task definition

Fill in the placeholders in `ecs/task-definition.json` (`<ECR_REPO_URI>`, `<IMAGE_TAG>` = `init`,
`<EXECUTION_ROLE_ARN>`, `<TASK_ROLE_ARN>`, `<AWS_REGION>`) then:

```bash
aws ecs register-task-definition --cli-input-json file://ecs/task-definition.json
```

### 2.10 Create the ECS service

```bash
aws ecs create-service \
  --cluster $CLUSTER_NAME \
  --service-name $SERVICE_NAME \
  --task-definition nodejs-cicd-demo \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$(echo $SUBNET_IDS | tr ',' ',')],securityGroups=[$SG_ID],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=$TG_ARN,containerName=nodejs-cicd-demo,containerPort=3000"
```

Get the app's public URL:

```bash
aws elbv2 describe-load-balancers --load-balancer-arns $ALB_ARN \
  --query 'LoadBalancers[0].DNSName' --output text
```

Everything above is a one-time setup. From here on, **the pipeline** does the deploys.

---

## 3. The CI/CD pipeline (pick one — both do the same thing)

### Option A — GitHub Actions (`.github/workflows/ci-cd.yml`)

On every push to `main`:
1. Runs `npm ci && npm test`.
2. Authenticates to AWS via OIDC (no static keys) using an IAM role you create and trust for
   `token.actions.githubusercontent.com`, stored as repo secret `AWS_DEPLOY_ROLE_ARN`.
3. Builds and pushes the Docker image to ECR, tagged with the commit SHA and `latest`.
4. Renders `ecs/task-definition.json` with the new image URI.
5. Registers the new task definition revision and updates the ECS service, then waits for it
   to become stable (this is what makes the deploy "real" — Actions won't report success until
   ECS confirms healthy tasks are running behind the ALB).

The deploy IAM role needs (scoped down for production): `ecr:GetAuthorizationToken`,
`ecr:BatchCheckLayerAvailability`, `ecr:PutImage`, `ecr:InitiateLayerUpload`,
`ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecs:RegisterTaskDefinition`,
`ecs:UpdateService`, `ecs:DescribeServices`, and `iam:PassRole` for the execution/task roles.

### Option B — Jenkins (`Jenkinsfile`)

Same five stages (checkout, test, build image, push to ECR, deploy to ECS), using the AWS CLI
directly on the Jenkins agent. Requires:
- AWS CLI + Docker installed on the agent (or run stages inside a Docker-in-Docker agent).
- An IAM instance profile / credentials on the agent with the same permissions listed above.
- A Jenkins "Secret text" credential named `aws-account-id`.

### Option C — CodeBuild/CodePipeline (`buildspec.yml`)

If you'd rather stay fully inside AWS: point a CodePipeline (Source = GitHub, Build = CodeBuild
using `buildspec.yml`, Deploy = "Amazon ECS") at this repo. `buildspec.yml` runs the tests,
builds/pushes the image, and emits `imagedefinitions.json`, which the CodePipeline ECS deploy
action consumes directly — no extra scripting needed.

---

## 4. What "real-time project" looks like day to day

1. You open a feature branch, change `src/app.js`, push, open a PR → CI runs tests only (no deploy).
2. PR merges to `main` → pipeline builds a new image tagged with the commit SHA, pushes to ECR,
   registers a new ECS task definition revision, and does a rolling update of the service.
3. ECS keeps the old tasks running until new ones pass the `/healthz` + ALB target-group health
   check, then drains and removes the old ones — zero-downtime by default.
4. `GET /metrics` on each task gives you request counts/latency/default Node process metrics you
   can wire into CloudWatch Container Insights or a self-hosted Prometheus + Grafana stack.
5. Roll back = redeploy the previous task definition revision:
   ```bash
   aws ecs update-service --cluster $CLUSTER_NAME --service $SERVICE_NAME \
     --task-definition nodejs-cicd-demo:<PREVIOUS_REVISION>
   ```

---

## 5. Repo layout

```
nodejs-cicd-demo/
├── src/
│   ├── app.js              # Express app, metrics, routes
│   └── routes/health.js    # /healthz, /readyz
├── test/app.test.js        # Jest + Supertest
├── ecs/task-definition.json# Fargate task def template
├── Dockerfile               # multi-stage, non-root
├── buildspec.yml            # CodeBuild option
├── Jenkinsfile               # Jenkins option
├── .github/workflows/ci-cd.yml # GitHub Actions option
└── package.json
```
