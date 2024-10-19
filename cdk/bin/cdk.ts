#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CdkStack } from '../lib/cdk-stack';
import * as dotenv from "dotenv";
import {AcmStack} from "../lib/acm-stack";

const app = new cdk.App();
dotenv.config()

const domainName = process.env.DOMAIN_NAME as string
const subdomain = 'iac-test';
const fullDomainName = `${subdomain}.${domainName}`;

const acmStack = new AcmStack(app, "AcmStack", {
  env: { account: process.env.AWS_ACCOUNT, region: 'us-east-1' },
  domainName,
  subdomain,
  fullDomainName
})

new CdkStack(app, 'CdkStack', {
  env: { account: process.env.AWS_ACCOUNT, region: process.env.AWS_REGION },
  crossRegionReferences: true,
  domainName,
  subdomain,
  fullDomainName,
  certificate: acmStack.certificate
});