import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import * as certificatemanager from "aws-cdk-lib/aws-certificatemanager";

interface CdkProps extends cdk.StackProps {
  subdomain: string
  domainName: string
  fullDomainName: string
  certificate: certificatemanager.Certificate
}

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CdkProps) {
    super(scope, id, props);

    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
      domainName: props.domainName,
    });

    // VPC
    const vpc = new ec2.Vpc(this, 'MyVPC', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // Security Groups
    const albSg = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for ALB',
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));

    const webServerSg = new ec2.SecurityGroup(this, 'WebServerSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for Web Servers',
    });
    webServerSg.addIngressRule(albSg, ec2.Port.tcp(80));
    webServerSg.addIngressRule(albSg, ec2.Port.tcp(443));

    const rdsSg = new ec2.SecurityGroup(this, 'RDSSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'Security group for RDS',
    });
    rdsSg.addIngressRule(webServerSg, ec2.Port.tcp(3306));

    // RDS
    const rdsInstance = new rds.DatabaseInstance(this, 'RDSInstance', {
      engine: rds.DatabaseInstanceEngine.mysql({ version: rds.MysqlEngineVersion.VER_8_0 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      multiAz: true,
      allocatedStorage: 20,
      storageType: rds.StorageType.GP2,
      securityGroups: [rdsSg],
    });

    // EC2 Launch Template
    const launchTemplate = new ec2.LaunchTemplate(this, 'WebServerLaunchTemplate', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2(),
      securityGroup: webServerSg,
    });

    // Auto Scaling Group
    const asg = new autoscaling.AutoScalingGroup(this, 'WebServerASG', {
      vpc,
      launchTemplate: launchTemplate,
      minCapacity: 1,
      maxCapacity: 3,
      desiredCapacity: 2,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    asg.scaleOnCpuUtilization('KeepCPUUtilizationAroundSeventy', {
      targetUtilizationPercent: 70,
    });

    // ACM Certificate for ALB
    const albCertificate = new acm.Certificate(this, 'ALBCertificate', {
      domainName: props.fullDomainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'WebServerALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
    });

    const httpListener = alb.addListener('HttpListener', { port: 80 });
    const httpsListener = alb.addListener('HttpsListener', {
      port: 443,
      certificates: [albCertificate],
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'WebServerTargetGroup', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [asg],
      healthCheck: { path: '/' },
    });

    httpListener.addTargetGroups('DefaultHttpRoute', { targetGroups: [targetGroup] });
    httpsListener.addTargetGroups('DefaultHttpsRoute', { targetGroups: [targetGroup] });

    // CloudFront Distribution
    const distribution = new cloudfront.Distribution(this, 'WebDistribution', {
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(alb),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      domainNames: [props.fullDomainName],
      certificate: props.certificate,
      defaultRootObject: 'index.html',
    });

    // Route 53 Alias Record
    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone,
      recordName: props.subdomain,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    // Outputs
    new cdk.CfnOutput(this, 'DomainName', {
      value: props.fullDomainName,
      description: 'Domain Name',
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront Distribution Domain Name',
    });
  }
}
