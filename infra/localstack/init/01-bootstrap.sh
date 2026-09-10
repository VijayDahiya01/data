#!/bin/bash
# LocalStack ready-hook: create the S3 bucket and SQS queues Oolix expects.
# Mirrors the queue/DLQ contract in spec §74.
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-ap-south-1}"

echo "[oolix] creating S3 creative bucket"
awslocal s3api create-bucket \
  --bucket oolix-creatives-local \
  --region "$REGION" \
  --create-bucket-configuration LocationConstraint="$REGION" 2>/dev/null || true

# §80: S3 versioning enabled for creative objects.
awslocal s3api put-bucket-versioning \
  --bucket oolix-creatives-local \
  --versioning-configuration Status=Enabled

# The SDK uploads creatives directly via a pre-signed PUT from the browser (§93).
awslocal s3api put-bucket-cors --bucket oolix-creatives-local --cors-configuration '{
  "CORSRules": [{
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedOrigins": ["http://localhost:3000"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }]
}'

create_queue_with_dlq () {
  local name="$1"
  local max_receive="${2:-5}"

  echo "[oolix] creating queue ${name} (+ DLQ, maxReceiveCount=${max_receive})"
  awslocal sqs create-queue --queue-name "${name}-dlq" \
    --attributes MessageRetentionPeriod=1209600 >/dev/null   # §74: DLQ retain 14 days

  local dlq_arn
  dlq_arn=$(awslocal sqs get-queue-attributes \
    --queue-url "http://localhost:4566/000000000000/${name}-dlq" \
    --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

  awslocal sqs create-queue --queue-name "${name}" --attributes "{
    \"VisibilityTimeout\": \"60\",
    \"MessageRetentionPeriod\": \"345600\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${dlq_arn}\\\",\\\"maxReceiveCount\\\":\\\"${max_receive}\\\"}\"
  }" >/dev/null
}

create_queue_with_dlq "oolix-domain-events" 5
create_queue_with_dlq "oolix-reporting" 5
create_queue_with_dlq "oolix-channel-sync" 5

echo "[oolix] localstack bootstrap complete"
awslocal sqs list-queues
