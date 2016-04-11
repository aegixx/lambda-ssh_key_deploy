# lambda-ssh_key_access
Automates creation of SSH users and deployment of public keys to EC2 instances.

## Setup
```
git clone git@github.com:aegixx/lambda-ssh_key_access.git
cd lambda-ssh_key_access
npm install
```

## S3 Bucket Configuration
This script assumes an S3 bucket path structure like:
```
acme-user-keys
    |
    \
     --------- user1
    |             |
    |             \
    |              --------- id_rsa      # private key
    |             |
    |             \
    |              --------- id_rsa.pub  # public key
    |
    \
     --------- user2
                  |
                  \
                   --------- id_rsa      # private key
                  |
                  \
                   --------- id_rsa.pub  # public key
```

## Lambda Execution IAM Role
You'll want to have at least the following permissions:
* s3:ListBucket*  (restrict to specific bucket holding public keys)
* s3:GetBucket*  
* s3:GetObject* (restrict to only public keys)
{{ TBD }}

#### Example:
```
{{ TBD }}
```

## AWS Lambda
(http://docs.aws.amazon.com/lambda/latest/dg/getting-started.html)

```
\# Zip the deployment package
zip -rq /tmp/lambda-ssh_key_access.zip *
\# Upload the deployment package to AWS Lambda or use CLI
aws lambda create-function --function-name "lambda-ssh_key_access" --runtime nodejs --role <YOUR_LAMBDA_IAM_ROLE> --handler index.handler --zip-file /tmp/lambda-ssh_key_access.zip
\# Refresh an existing Lambda function deployment package
aws lambda update-function-code --function-name "lambda-ssh_key_access" --zip-file /tmp/lambda-ssh_key_access.zip
```