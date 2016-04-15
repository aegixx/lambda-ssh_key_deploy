# lambda-ssh_key_deploy
Securely automate SSH user access to EC2 instances via [AWS Lambda](http://docs.aws.amazon.com/lambda/latest/dg/getting-started.html).  Create / Revoke user access to a fleet of systems quickly and without handing out your master key credentials.

## Setup

#### 1) Configure S3 buckets
##### Master Keys (```acme-master-keys```)
This stores all of the master private keys that are used as root credentials for newly deployed EC2 instances.  This bucket should be **TIGHTLY** controlled.

*This bucket should be protected by a [master_policy](#master_policy) applied to all users.*

* All master keys should be encrypted using the [master_encryption_key](#master_encryption_key) created in the next step.
* Enable Versioning
* Enable Logging (to a separate bucket)

##### User Keys (```acme-user-keys```)
This stores all of the individual user public keys that are deployed to / revoked from EC2 instances.  Ability to edit this bucket should be **tightly** controlled, however public keys are safe to be viewed by others.

*This bucket should be protected by a [user policy](#user_policy).*

* All user public keys should be encrypted using the [user_encryption_key](#user_encryption_key) created in the next step.
* The expected S3 object key path is: ```/[username]/id_rsa.pub```
* Enable Versioning
* Enable Logging (to a separate bucket)

###### Bucket / Key Layout
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

#### 2) Security Configuration
<a name="lambda_policy"></a>
##### (IAM) Lambda Execution Role Policy
This policy should be created alongside and attached to the Lambda Execution Role.  These are the permissions the Lambda function will need to do its job.
###### Permissions:
* s3:ListBucket / s3:GetBucket
    * User + Master key buckets
* s3:GetObject
    * User key bucket - only public keys (in case you want to store private keys here)
    * Master key bucket
* kms:Describe* / kms:Get*
    * Encryption keys used for encrypting the S3 bucket objects
###### Example:
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
                "kms:Get*",
                "kms:Decrypt"
            ],
            "Resource": [
                "arn:aws:kms:us-east-1:123456789012:alias/MASTER-KEY-ID",
                "arn:aws:kms:us-east-1:123456789012:alias/USER-KEY-ID"
            ]
        }
    ]
}
```

<a name="user_policy"></a>
##### (IAM) User Policy
This policy should be attached to any users / roles you want to be allowed to manage system access.  They will have administrative access to everyone's public keys.
###### Permissions:
* s3:ListBucket / s3:GetObject* / s3:DeleteObject
    * Allows users to get / modify the public keys
* kms:Describe* / kms:List* / kms:GetKey* / kms:Encrypt
    * Allow them to use the encryption key for decrypting & encrypting new keys
###### Example:
```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:ListBucket",
                "s3:GetBucketLocation",
                "s3:ListAllMyBuckets"
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
            "Action": ["s3:PutObject*", "s3:DeleteObject*"],
            "Resource": "arn:aws:s3:::acme-user-keys/*/"
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
                "kms:Get*",
                "kms:Decrypt"
            ],
            "Resource": "arn:aws:kms:us-east-1:1234567890:key/USER-KEY-ID"
        }
    ]
}
```

<a name="master_policy"></a>
##### (IAM) Master Policy
This policy should be attached to ALL users / roles to prevent any but root from modifying your master keys.
###### Example:
```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Deny",
            "Action": "s3:*",
            "Resource": "arn:aws:s3:::kailos-master-keys-staging/*"
        }
    ]
}
```

<a name="encryption_keys"></a>
##### (IAM - KMS) Encryption Keys

<a name="master_encryption_key"></a>
###### Master Key Encryption (master-key-mgmt)
* Only the root user can admin
* Only administrators can use

<a name="user_encryption_key"></a>
###### User Key Encryption (user-key-mgmt)
* Only administrators can admin
* All users can use

##### 3) Clone Lambda source
```bash
# Clone repository
git clone git@github.com:aegixx/lambda-ssh_key_deploy.git

# Install dependencies
cd lambda-ssh_key_deploy
npm install
```

##### 4) Personalize configuration
* Review the configuration file: ```config.js```
    * At a minimum, set ```masterKeyBucket``` to the location your master keys should be read from.

##### 5) Deploy function to AWS Lambda

You can do this through the AWS Management Console directly, or to do it via AWS CLI using:

**NOTE:** *Make sure and replace ```YOUR_LAMBDA_IAM_ROLE``` with the Lambda IAM Execution Role you created in Step #2*
```bash
# Zip the deployment package
zip -rq /tmp/lambda-ssh_key_deploy.zip *

# Upload the deployment package to AWS Lambda or use CLI
aws lambda create-function --function-name "lambda-ssh_key_deploy" --runtime nodejs --role YOUR_LAMBDA_IAM_ROLE --handler index.handler --zip-file fileb:///tmp/lambda-ssh_key_deploy.zip
aws lambda update-function-configuration --function-name "lambda-ssh_key_deploy" --timeout 30
```

##### 6) Test by manually invoking
```bash
# Upload a valid public key to your newly created S3 user keys bucket
aws s3 cp ~/.ssh/id_rsa.pub s3://acme-user-keys/john.doe/

# Invoke the function using the test.event.json as your payload
aws lambda invoke --function-name "lambda-ssh_key_deploy" --invocation-type RequestResponse --log-type Tail --payload fileb://test.event.json /dev/stdout 2>/dev/null | sed 's/^null//' | jq '.LogResult' | sed 's/\"//g' | base64 -D
```

##### 7) Add S3 event sources for triggering Lambda
I recommend doing this directly from the AWS Management Console -- for assistance, see [Using AWS Lambda with Amazon S3](http://docs.aws.amazon.com/lambda/latest/dg/with-s3.html).