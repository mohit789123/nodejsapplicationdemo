pipeline {
  agent any

  environment {
    AWS_REGION        = 'us-east-1'
    AWS_ACCOUNT_ID     = credentials('aws-account-id')       // Jenkins secret text credential
    ECR_REPOSITORY     = 'nodejs-cicd-demo'
    ECS_CLUSTER        = 'nodejs-cicd-demo-cluster'
    ECS_SERVICE        = 'nodejs-cicd-demo-service'
    CONTAINER_NAME     = 'nodejs-cicd-demo'
    IMAGE_TAG          = "${env.GIT_COMMIT.take(7)}"
    REPO_URI           = "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"
  }

  stages {
    stage('Checkout') {
      steps { checkout scm }
    }

    stage('Install & Test') {
      steps {
        sh 'npm ci'
        sh 'npm test'
      }
    }

    stage('Build Docker Image') {
      steps {
        sh "docker build --build-arg APP_VERSION=${IMAGE_TAG} -t ${REPO_URI}:${IMAGE_TAG} -t ${REPO_URI}:latest ."
      }
    }

    stage('Push to ECR') {
      steps {
        sh """
          aws ecr get-login-password --region ${AWS_REGION} | \
            docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com
          docker push ${REPO_URI}:${IMAGE_TAG}
          docker push ${REPO_URI}:latest
        """
      }
    }

    stage('Render Task Definition') {
      steps {
        sh """
          sed -e 's#<ECR_REPO_URI>:<IMAGE_TAG>#${REPO_URI}:${IMAGE_TAG}#' \
              -e 's#<AWS_REGION>#${AWS_REGION}#' \
              ecs/task-definition.json > ecs/task-definition.rendered.json
        """
      }
    }

    stage('Deploy to ECS') {
      steps {
        sh """
          NEW_TASK_ARN=\$(aws ecs register-task-definition \
            --cli-input-json file://ecs/task-definition.rendered.json \
            --region ${AWS_REGION} \
            --query 'taskDefinition.taskDefinitionArn' --output text)

          aws ecs update-service \
            --cluster ${ECS_CLUSTER} \
            --service ${ECS_SERVICE} \
            --task-definition \$NEW_TASK_ARN \
            --region ${AWS_REGION}

          aws ecs wait services-stable \
            --cluster ${ECS_CLUSTER} \
            --services ${ECS_SERVICE} \
            --region ${AWS_REGION}
        """
      }
    }
  }

  post {
    success { echo "Deployed ${IMAGE_TAG} to ECS service ${ECS_SERVICE}" }
    failure { echo "Pipeline failed - check logs above" }
  }
}
