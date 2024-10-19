import * as cdk from 'aws-cdk-lib';
import * as route53 from "aws-cdk-lib/aws-route53"
import * as certificatemanager from "aws-cdk-lib/aws-certificatemanager"
import {Construct} from "constructs";

interface AcmProps extends cdk.StackProps {
    subdomain: string
    domainName: string
    fullDomainName: string
}

export class AcmStack  extends cdk.Stack{
    public readonly certificate: certificatemanager.Certificate

    constructor(scope: Construct, id: string, props: AcmProps) {
        super(scope, id, props);

        const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
            domainName: props.domainName,
        })

        this.certificate = new certificatemanager.Certificate(this, "Certificate", {
            domainName: props?.fullDomainName,
            validation: certificatemanager.CertificateValidation.fromDns(hostedZone),
        })
    }
}