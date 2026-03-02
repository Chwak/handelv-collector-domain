import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { DomainStackProps } from "./domain-stack-props";
import { CollectorAppSyncConstruct } from "./constructs/appsync/collector-appsync/collector-appsync-construct";
import { CollectorTablesConstruct } from "./constructs/dynamodb/collector-tables/collector-tables-construct";
import { OutboxTableConstruct } from "./constructs/dynamodb/outbox-table/outbox-table-construct";
import { RepublishLambdaConstruct } from "./constructs/lambda/republish/republish-lambda-construct";
import { NewCollectorFromAuthLambdaConstruct } from "./constructs/lambda/collector/new-collector-from-auth/new-collector-from-auth-lambda-construct";
import { GetCollectorProfileLambdaConstruct } from "./constructs/lambda/collector/get-collector-profile/get-collector-profile-lambda-construct";
import { UpdateCollectorProfileLambdaConstruct } from "./constructs/lambda/collector/update-collector-profile/update-collector-profile-lambda-construct";
import { GetCollectorSettingsLambdaConstruct } from "./constructs/lambda/collector/get-collector-settings/get-collector-settings-lambda-construct";
import { UpdateCollectorSettingsLambdaConstruct } from "./constructs/lambda/collector/update-collector-settings/update-collector-settings-lambda-construct";
import { CollectorAppSyncResolversConstruct } from "./constructs/appsync/collector-appsync-resolvers/collector-appsync-resolvers-construct";
import { importEventBusFromSharedInfra } from "./utils/eventbridge-helper";

export class CollectorDomainStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DomainStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add("Domain", "hand-made-collector-domain");
    cdk.Tags.of(this).add("Environment", props.environment);
    cdk.Tags.of(this).add("Project", "hand-made");
    cdk.Tags.of(this).add("Region", props.regionCode);
    cdk.Tags.of(this).add("StackName", this.stackName);

    const removalPolicy = props.environment === 'prod'
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY;

    // Create DynamoDB tables
    const collectorTables = new CollectorTablesConstruct(this, "CollectorTables", {
      environment: props.environment,
      regionCode: props.regionCode,
      removalPolicy,
    });

    const idempotencyTable = new dynamodb.Table(this, "CollectorIdempotencyTable", {
      tableName: `${props.environment}-${props.regionCode}-collector-domain-idempotency`,
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "expires_at",
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.environment === "prod" },
    });

    const sharedEventBus = importEventBusFromSharedInfra(this, props.environment);
    const schemaRegistryName = ssm.StringParameter.valueForStringParameter(
      this,
      `/${props.environment}/shared-infra/glue/schema-registry-name`,
    );

    // ========== PRODUCER PATTERN: Outbox + Republish ==========
    const outboxTable = new OutboxTableConstruct(this, "OutboxTable", {
      environment: props.environment,
      regionCode: props.regionCode,
      domainName: "collector-domain",
      removalPolicy,
    });

    const republishLambda = new RepublishLambdaConstruct(this, "RepublishLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      domainName: "collector-domain",
      outboxTable: outboxTable.table,
      eventBus: sharedEventBus,
      schemaRegistryName,
      removalPolicy,
    });

    // ========== CONSUMER PATTERN: SQS + Idempotency ==========
    // Create new collector from auth events
    new NewCollectorFromAuthLambdaConstruct(this, "NewCollectorFromAuthLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      collectorProfiles: collectorTables.collectorProfiles,
      collectorSettings: collectorTables.collectorSettings,
      eventBus: sharedEventBus,
      idempotencyTable,
      outboxTable: outboxTable.table,
      schemaRegistryName,
      removalPolicy,
    });

    // Create AppSync GraphQL API for Collector Domain
    const collectorAppSync = new CollectorAppSyncConstruct(this, "CollectorAppSync", {
      environment: props.environment,
      regionCode: props.regionCode,
    });

    // Export table names to SSM for cross-stack references
    new ssm.StringParameter(this, 'CollectorProfilesTableNameParameter', {
      parameterName: `/${props.environment}/collector-domain/dynamodb/profiles-table-name`,
      stringValue: collectorTables.collectorProfiles.tableName,
      description: 'Collector Profiles DynamoDB Table Name',
    });

    new ssm.StringParameter(this, 'CollectorSettingsTableNameParameter', {
      parameterName: `/${props.environment}/collector-domain/dynamodb/settings-table-name`,
      stringValue: collectorTables.collectorSettings.tableName,
      description: 'Collector Settings DynamoDB Table Name',
    });

    // Core profile operations
    const getCollectorProfileLambda = new GetCollectorProfileLambdaConstruct(this, "GetCollectorProfileLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      collectorProfiles: collectorTables.collectorProfiles,
      removalPolicy,
    });

    const updateCollectorProfileLambda = new UpdateCollectorProfileLambdaConstruct(this, "UpdateCollectorProfileLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      collectorProfiles: collectorTables.collectorProfiles,
      auditLogs: collectorTables.collectorAuditLogs,
      idempotencyTable,
      removalPolicy,
    });

    const getCollectorSettingsLambda = new GetCollectorSettingsLambdaConstruct(this, "GetCollectorSettingsLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      collectorSettings: collectorTables.collectorSettings,
      removalPolicy,
    });

    const updateCollectorSettingsLambda = new UpdateCollectorSettingsLambdaConstruct(this, "UpdateCollectorSettingsLambda", {
      environment: props.environment,
      regionCode: props.regionCode,
      collectorSettings: collectorTables.collectorSettings,
      auditLogs: collectorTables.collectorAuditLogs,
      idempotencyTable,
      removalPolicy,
    });

    // Create AppSync resolvers
    new CollectorAppSyncResolversConstruct(this, "CollectorResolvers", {
      api: collectorAppSync.api,
      getCollectorProfileLambda: getCollectorProfileLambda.function,
      updateCollectorProfileLambda: updateCollectorProfileLambda.function,
      getCollectorSettingsLambda: getCollectorSettingsLambda.function,
      updateCollectorSettingsLambda: updateCollectorSettingsLambda.function,
    });
  }
}
