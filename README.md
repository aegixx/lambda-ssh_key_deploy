# lambda-ssh_key_deploy
Securely automate SSH user access to EC2 instances via [AWS Lambda](http://docs.aws.amazon.com/lambda/latest/dg/getting-started.html).  Create / Revoke user access to a fleet of systems quickly and without handing out your master key credentials.

## Setup

#### Create Lambda Execution Policy

```bash
# Clone repository
git clone git@github.com:aegixx/lambda-ssh_key_deploy.git

# Install dependencies
cd lambda-ssh_key_deploy
npm install

# Zip the deployment package
zip -rq /tmp/lambda-ssh_key_deploy.zip *

# Upload the deployment package to AWS Lambda or use CLI
aws lambda create-function --function-name "lambda-ssh_key_deploy" --runtime nodejs --role <YOUR_LAMBDA_IAM_ROLE> --handler index.handler --zip-file fileb:///tmp/lambda-ssh_key_deploy.zip
```

## S3 Bucket Configuration
(Make sure and read [Security Recommendations](#security))
This script assumes an S3 bucket path structure like:
```
# Contains master private keys used to deploy instances
acme-master-keys
    |
    \
     --------- acme-master

# Contains users' public keys
acme-user-keys
    |
    \
     --------- john.doe # Username
    |             |
    |             \
    |              --------- id_rsa.pub  # public key
    |
    \
     --------- jane.doe
                  |
                  \
                   --------- id_rsa.pub
```

## Security Recommendations
#### (IAM) Lambda Execution Role
##### Permissions:
* s3:ListBucket / s3:GetBucket
    * User + Master key buckets
* s3:GetObject
    * User key bucket - only public keys (in case you want to store private keys here)
    * Master key bucket
* kms:Describe* / kms:Get*
    * Encryption keys used for encrypting the S3 bucket objects
##### Example:
```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:ListBucket",
                "s3:GetBucket"
            ],
            "Resource": [
                "arn:aws:s3:::acme-user-keys",
                "arn:aws:s3:::acme-master-keys"
            ]
        },
        {
            "Effect": "Allow",
            "Action": [
                "s3:GetObject"
            ],
            "Resource": [
                "arn:aws:s3:::acme-user-keys/*/id_rsa.pub",
                "arn:aws:s3:::acme-master-keys/*"
            ]
        },
        {
            "Effect": "Allow",
            "Action": [
                "kms:Describe*",
                "kms:Get*"
            ],
            "Resource": [
                "arn:aws:kms:us-east-1:123456789012:alias/master-key-mgmt",
                "arn:aws:kms:us-east-1:123456789012:alias/user-key-mgmt"
            ]
        }
    ]
}
```

#### (IAM) Users Policy
##### Permissions:
* s3:ListBucket / s3:GetObject* / s3:DeleteObject
    * Allows users to get / modify the public keys
* kms:Describe* / kms:List* / kms:GetKey* / kms:Encrypt
    * Allow them to use the encryption key for decrypting & encrypting new keys
##### Example:
```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:ListBucket"
            ],
            "Resource": [
                "arn:aws:s3:::acme-user-keys"
            ]
        },
        {
            "Effect": "Allow",
            "Action": [
                "s3:GetObject*",
                "s3:DeleteObject"
            ],
            "Resource": [
                "arn:aws:s3:::acme-user-keys/*/id_rsa.pub"
            ]
        },
        {
            "Effect": "Allow",
            "Action": "s3:PutObject*",
            "Resource": "arn:aws:s3:::acme-user-keys/*/id_rsa.pub",
            "Condition": {
                "StringEquals": {
                    "s3:x-amz-server-side-encryption": "aws:kms"
                }
            }
        },
        {
            "Effect": "Allow",
            "Action": [
                "kms:Describe*",
                "kms:List*",
                "kms:GetKey*"
            ],
            "Resource": "arn:aws:kms:us-east-1:123456789:alias/user-key-mgmt"
        }
    ]
}
```

#### (S3) Master Key bucket (i.e. acme-master-keys)
* Enable Versioning
* Enable Logging (to a separate bucket)

#### (S3) User Key bucket (i.e. acme-user-keys)
* Enable Versioning
* Enable Logging (to a separate bucket)

#### (IAM - KMS) Encryption Keys

###### Master Key Encryption (master-key-mgmt)
* Only the root user can admin
* Only administrators can use

###### User Key Encryption (user-key-mgmt)
* Only administrators can admin
* All users can use

## Testing using AWS CLI
```
# Invoke the function using the test.event.json as your payload
aws --profile staging lambda invoke --function-name "lambda-ssh_key_deploy" --invocation-type RequestResponse --log-type Tail --payload fileb://test.event.json /dev/stdout 2>/dev/null | sed 's/^null//' | jq '.LogResult' | sed 's/\"//g' | base64 -D
```