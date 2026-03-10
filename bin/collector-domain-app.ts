#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { CollectorDomainStack } from "../lib/collector-domain-stack";
import { CollectorDomainPipelineStack } from "../lib/collector-domain-pipeline-stack";

const app = new cdk.App();

const environment = process.env.ENVIRONMENT ?? app.node.tryGetContext("environment") ?? "dev";
const regionCode = process.env.REGION_CODE ?? app.node.tryGetContext("regionCode") ?? "use1";

// Account mapping based on environment
const accountMapping: Record<string, string> = {
  dev: "741429964649",
  mimic: "329177708881",
  prod: "021657748325",
};

const targetAccount = accountMapping[environment] ?? process.env.CDK_DEFAULT_ACCOUNT;

new CollectorDomainStack(app, `${environment}-${regionCode}-hand-made-collector-domain-stack`, {
  env: {
    account: targetAccount,
    region: process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  environment,
  regionCode,
});

// Domain-scoped pipeline infrastructure
const managementAccountId = "567608120268";
const devAccountId = "741429964649";
const mimicProdAccountId = "329177708881";
const prodAccountId = "021657748325";
const githubConnectionArn = "arn:aws:codeconnections:us-east-1:567608120268:connection/6b01e09c-3e85-4c07-8ca7-e4313f3f1a45";

new CollectorDomainPipelineStack(
  app,
  "CollectorDomainPipelineStack",
  {
    env: { account: managementAccountId, region: "us-east-1" },
    domain: "collector-domain",
    managementAccountId,
    devAccountId,
    mimicProdAccountId,
    prodAccountId,
    githubConnectionArn,
    description: "Domain-scoped pipeline for collector-domain",
  }
);

app.synth();
