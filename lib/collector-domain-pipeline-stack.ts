/**
 * Auth Essentials Domain Pipeline Stack
 * 
 * Self-contained pipeline infrastructure for the collector-domain domain:
 * - CodePipeline that triggers from GitHub
 * - Artifact bucket (domain-scoped, not shared)
 
 * - Deploy to dev, mimic, and prod with approval gates
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as pipelines from 'aws-cdk-lib/pipelines';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';

export interface CollectorDomainPipelineStackProps extends cdk.StackProps {
  domain: string;
  managementAccountId: string;
  devAccountId: string;
  mimicProdAccountId: string;
  prodAccountId: string;
  githubConnectionArn: string;
}

export class CollectorDomainPipelineStack extends cdk.Stack {
  public readonly artifactBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: CollectorDomainPipelineStackProps) {
    super(scope, id, props);

    const {
      domain,
      managementAccountId,
      devAccountId,
      mimicProdAccountId,
      prodAccountId,
      githubConnectionArn,
    } = props;// Create domain-scoped artifact bucket
    this.artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `handelv-${domain}-artifacts-${managementAccountId}`,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          noncurrentVersionExpiration: cdk.Duration.days(7),
          expiration: cdk.Duration.days(90),
        },
      ],
      enforceSSL: true,
    });

    // Create GitHub source
    const source = pipelines.CodePipelineSource.connection(
      `Chwak/handelv-${domain}`,
      'main',
      {
        connectionArn: githubConnectionArn,
        triggerOnPush: true,
      }
    );

    // Create pipeline
    const pipeline = new pipelines.CodePipeline(this, 'Pipeline', {
      pipelineName: `Handelv-${this.pascalCase(domain)}`,
      artifactBucket: this.artifactBucket,
      publishAssetsInParallel: false,
      selfMutation: false,

      synth: new pipelines.ShellStep('Synth', {
        input: source,
        commands: [
          'npm ci --no-audit --no-fund',
          'npm run build',
          'npx cdk synth',
        ],
        primaryOutputDirectory: 'cdk.out',
      }),

      codeBuildDefaults: {
        buildEnvironment: {
          buildImage: cdk.aws_codebuild.LinuxBuildImage.STANDARD_7_0,
          computeType: cdk.aws_codebuild.ComputeType.SMALL,
          environmentVariables: {
            PIPELINE_EXECUTION_ID: {
              value: cdk.aws_codepipeline.GlobalVariables.executionId,
            },
            DOMAIN: {
              value: domain,
            },
            BUILD_TIMESTAMP: {
              value: new Date().toISOString(),
            },
          },
        },
        logging: {
          cloudWatch: {
            logGroup: new logs.LogGroup(this, 'LogGroup', {
              logGroupName: `/aws/codebuild/handelv-${domain}-pipeline`,
              retention: logs.RetentionDays.ONE_MONTH,
              removalPolicy: cdk.RemovalPolicy.DESTROY,
            }),
          },
        },
        timeout: cdk.Duration.minutes(30),
        rolePolicy: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['sts:AssumeRole'],
            resources: [
              `arn:aws:iam::${devAccountId}:role/cdk-hnb659fds-deploy-role-*`,
              `arn:aws:iam::${mimicProdAccountId}:role/cdk-hnb659fds-deploy-role-*`,
              `arn:aws:iam::${prodAccountId}:role/cdk-hnb659fds-deploy-role-*`,
            ],
          }),
        ],
      },
    });

    // Dev deployment
    pipeline.addWave('DeployToDev', {
      post: [
        new pipelines.CodeBuildStep(`Deploy${this.pascalCase(domain)}Dev`, {
          commands: [
            'set -euo pipefail',
            `echo "=== Deploying ${domain} to dev ==="`,
            `export ENVIRONMENT=dev AWS_REGION=us-east-1`,
            'npm ci --no-audit --no-fund',
            'npm run build',
            'npx cdk deploy --require-approval never',
            `echo "✓ ${domain} deployed to dev"`,
          ],
        }),
      ],
    });

    // Mimic production
    pipeline.addWave('DeployToMimic', {
      post: [
        new pipelines.CodeBuildStep(`Deploy${this.pascalCase(domain)}Mimic`, {
          commands: [
            'set -euo pipefail',
            `echo "=== Deploying ${domain} to mimic ==="`,
            `export ENVIRONMENT=mimic AWS_REGION=us-east-1`,
            'npm ci --no-audit --no-fund',
            'npm run build',
            'npx cdk deploy --require-approval never',
            `echo "✓ ${domain} deployed to mimic"`,
          ],
        }),
      ],
    });

    // Production with approval
    const prodApproval = new pipelines.ManualApprovalStep(`ApproveProd`, {
      comment: `Approve production deployment for ${domain}`,
    });

    pipeline.addWave('DeployToProd', {
      pre: [prodApproval],
      post: [
        new pipelines.CodeBuildStep(`Deploy${this.pascalCase(domain)}Prod`, {
          commands: [
            'set -euo pipefail',
            `echo "=== Deploying ${domain} to production ==="`,
            `export ENVIRONMENT=prod AWS_REGION=us-east-1`,
            'npm ci --no-audit --no-fund',
            'npm run build',
            'npx cdk deploy --require-approval never',
            `echo "✓ ${domain} deployed to production"`,
          ],
        }),
      ],
    });

    pipeline.buildPipeline();

    // Outputs
    new cdk.CfnOutput(this, 'PipelineName', {
      value: pipeline.pipeline.pipelineName,
      exportName: `${domain}-pipeline-name`,
      description: `Pipeline name for ${domain}`,
    });

    new cdk.CfnOutput(this, 'PipelineArn', {
      value: pipeline.pipeline.pipelineArn,
      exportName: `${domain}-pipeline-arn`,
      description: `Pipeline ARN for ${domain}`,
    });

    new cdk.CfnOutput(this, 'ArtifactBucketName', {
      value: this.artifactBucket.bucketName,
      exportName: `${domain}-artifact-bucket`,
      description: `Artifact bucket for ${domain}`,
    });
  }

  private pascalCase(value: string): string {
    return value
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
  }
}
