import type { StackProps } from "aws-cdk-lib";

export interface DomainStackProps extends StackProps {
  readonly environment: string;
  readonly regionCode: string;
}
