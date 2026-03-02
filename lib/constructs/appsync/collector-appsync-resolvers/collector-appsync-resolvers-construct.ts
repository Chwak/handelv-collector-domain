import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface CollectorAppSyncResolversConstructProps {
  api: appsync.IGraphqlApi;
  getCollectorProfileLambda?: lambda.IFunction;
  updateCollectorProfileLambda?: lambda.IFunction;
  getCollectorSettingsLambda?: lambda.IFunction;
  updateCollectorSettingsLambda?: lambda.IFunction;
}

export class CollectorAppSyncResolversConstruct extends Construct {
  constructor(scope: Construct, id: string, props: CollectorAppSyncResolversConstructProps) {
    super(scope, id);

    // Query Resolvers
    if (props.getCollectorProfileLambda) {
      const getCollectorProfileDataSource = props.api.addLambdaDataSource(
        'GetCollectorProfileDataSource',
        props.getCollectorProfileLambda
      );

      getCollectorProfileDataSource.createResolver('GetCollectorProfileResolver', {
        typeName: 'Query',
        fieldName: 'getCollectorProfile',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }

    if (props.getCollectorSettingsLambda) {
      const getCollectorSettingsDataSource = props.api.addLambdaDataSource(
        'GetCollectorSettingsDataSource',
        props.getCollectorSettingsLambda
      );

      getCollectorSettingsDataSource.createResolver('GetCollectorSettingsResolver', {
        typeName: 'Query',
        fieldName: 'getCollectorSettings',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }

    // Mutation Resolvers
    if (props.updateCollectorProfileLambda) {
      const updateCollectorProfileDataSource = props.api.addLambdaDataSource(
        'UpdateCollectorProfileDataSource',
        props.updateCollectorProfileLambda
      );

      updateCollectorProfileDataSource.createResolver('UpdateCollectorProfileResolver', {
        typeName: 'Mutation',
        fieldName: 'updateCollectorProfile',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }

    if (props.updateCollectorSettingsLambda) {
      const updateCollectorSettingsDataSource = props.api.addLambdaDataSource(
        'UpdateCollectorSettingsDataSource',
        props.updateCollectorSettingsLambda
      );

      updateCollectorSettingsDataSource.createResolver('UpdateCollectorSettingsResolver', {
        typeName: 'Mutation',
        fieldName: 'updateCollectorSettings',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }
  }
}
