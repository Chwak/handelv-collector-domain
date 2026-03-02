import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Utility to add CloudWatch Log retention to Lambda functions via LogRetention construct.
 *
 * Uses an explicit LogRetention role (no CDK auto-generated role). The custom role MUST have
 * logs:CreateLogGroup, logs:PutRetentionPolicy, logs:DescribeLogGroups, and (for DESTROY)
 * logs:DeleteLogGroup / logs:DescribeLogStreams / logs:DeleteLogStream.
 *
 * Cost Optimization: Set retention to 1 day to reduce CloudWatch Logs costs by ~95%
 * Logs are exported to S3 for long-term storage (90% cheaper)
 */
export function addLogRetention(
  scope: Construct,
  lambdaFunction: lambda.Function,
  retentionDays: logs.RetentionDays = logs.RetentionDays.ONE_WEEK,
  role: iam.IRole
): logs.LogRetention {
  const logGroupName = `/aws/lambda/${lambdaFunction.functionName}`;

  const logRetention = new logs.LogRetention(scope, `${lambdaFunction.node.id}LogRetention`, {
    logGroupName,
    retention: retentionDays,
    role,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  lambdaFunction.node.addDependency(logRetention);

  return logRetention;
}
