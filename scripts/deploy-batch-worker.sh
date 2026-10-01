#!/usr/bin/env bash
set -euo pipefail

: "${VPC_ID:?Set VPC_ID, ví dụ vpc-0123456789abcdef0}"
: "${SUBNET_IDS:?Set SUBNET_IDS dạng subnet-a,subnet-b}"

AWS_REGION="${AWS_REGION:-ap-southeast-1}"
STACK_NAME="${STACK_NAME:-prayer-studio-batch}"

aws cloudformation deploy \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --template-file infra/aws-batch-one-worker.yml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides "VpcId=$VPC_ID" "SubnetIds=$SUBNET_IDS"

output() {
  aws cloudformation describe-stacks \
    --region "$AWS_REGION" \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text
}

REPOSITORY_URI="$(output WorkerRepositoryUri)"
REGISTRY="${REPOSITORY_URI%%/*}"
aws ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "$REGISTRY"

# Oracle VM là ARM nên build native; --network=host tránh lỗi DNS Docker đã gặp.
docker build --network=host -f Dockerfile.batch -t "$REPOSITORY_URI:latest" .
docker push "$REPOSITORY_URI:latest"

cat <<EOF

Thêm các dòng sau vào /opt/prayer-studio/.env:
AWS_BATCH_REGION=$AWS_REGION
AWS_BATCH_BUCKET=$(output RenderBucketName)
AWS_BATCH_JOB_QUEUE=$(output JobQueueArn)
AWS_BATCH_JOB_DEFINITION=$(output JobDefinitionArn)

Sau đó chạy:
  cd /opt/prayer-studio
  docker compose up -d --force-recreate
EOF
