import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const config = new pulumi.Config("aws-cli-sandbox");
const awsConfig = new pulumi.Config("aws");
const domainName = config.require("domainName");
const subdomain = config.require("subdomain");
const fullDomainName = `${subdomain}.${domainName}`;
const region = awsConfig.require("region");

const usProvider =  new aws.Provider(
    "provider",
    {
        region: "us-east-1",
        profile: awsConfig.require("profile")
        }
    )

// Create an ACM certificate
const certificate = new aws.acm.Certificate("certificate", {
        domainName: fullDomainName,
        validationMethod: "DNS",
    },
    { provider: usProvider}
    );

// Create a Route53 DNS record for validation
const zone = aws.route53.getZone({ name: domainName });
const validationRecord = new aws.route53.Record("validationRecord", {
        zoneId: zone.then(zone => zone.id),
        name: certificate.domainValidationOptions[0].resourceRecordName,
        type: certificate.domainValidationOptions[0].resourceRecordType,
        records: [certificate.domainValidationOptions[0].resourceRecordValue],
        ttl: 60,
    },
        { provider: usProvider}
    );

// ACM Certificate validation
const certificateValidation = new aws.acm.CertificateValidation("certificateValidation", {
        certificateArn: certificate.arn,
        validationRecordFqdns: [validationRecord.fqdn],
    },
    { provider: usProvider}
    );

// Create a VPC
const vpc = new aws.ec2.Vpc("vpc", {
    cidrBlock: "10.0.0.0/16",
    enableDnsSupport: true,
    enableDnsHostnames: true,
});

const internetGateway = new aws.ec2.InternetGateway("InternetGateway", {
    vpcId: vpc.id
})

// Create subnets
const publicSubnet = new aws.ec2.Subnet("publicSubnet", {
    vpcId: vpc.id,
    cidrBlock: "10.0.1.0/24",
    availabilityZone: `${region}a`,
});

const publicSubnet2 = new aws.ec2.Subnet("publicSubnet2", {
    vpcId: vpc.id,
    cidrBlock: "10.0.11.0/24",
    availabilityZone: `${region}c`,
});

const privateSubnet = new aws.ec2.Subnet("privateSubnet", {
    vpcId: vpc.id,
    cidrBlock: "10.0.31.0/24",
    availabilityZone: `${region}a`,
});

const privateSubnet2 = new aws.ec2.Subnet("privateSubnet2", {
    vpcId: vpc.id,
    cidrBlock: "10.0.41.0/24",
    availabilityZone: `${region}c`,
});

// Create security groups
const albSg = new aws.ec2.SecurityGroup("albSg", {
    vpcId: vpc.id,
    description: "Security group for ALB",
    ingress: [
        { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] },
        { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"] },
    ],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
});

const webServerSg = new aws.ec2.SecurityGroup("webServerSg", {
    vpcId: vpc.id,
    description: "Security group for Web Servers",
    ingress: [
        { protocol: "tcp", fromPort: 80, toPort: 80, securityGroups: [albSg.id] },
        { protocol: "tcp", fromPort: 443, toPort: 443, securityGroups: [albSg.id] },
    ],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
});

const rdsSg = new aws.ec2.SecurityGroup("rdsSg", {
    vpcId: vpc.id,
    description: "Security group for RDS",
    ingress: [
        { protocol: "tcp", fromPort: 3306, toPort: 3306, securityGroups: [webServerSg.id] },
    ],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
});

// Create an RDS instance
const rdsInstance = new aws.rds.Instance("rdsInstance", {
    engine: "mysql",
    instanceClass: "db.t3.micro",
    allocatedStorage: 20,
    dbSubnetGroupName: new aws.rds.SubnetGroup("rdsSubnetGroup", {
        name: "rds-group",
        subnetIds: [privateSubnet.id, privateSubnet2.id],
    }).name,
    identifier: "pulumi-instance",
    vpcSecurityGroupIds: [rdsSg.id],
    multiAz: true,
    publiclyAccessible: false,
    username: "admin",
    password: "xxxxxxxxxxx",
});

// Create a launch template for Auto Scaling Group
const launchTemplate = new aws.ec2.LaunchTemplate("launchTemplate", {
    instanceType: "t3.micro",
    imageId: aws.ec2.getAmi({
        mostRecent: true,
        owners: ["amazon"],
        filters: [{ name: "name", values: ["amzn2-ami-hvm-*-x86_64-gp2"] }],
    }).then(ami => ami.id),
    vpcSecurityGroupIds: [webServerSg.id],
});

// Create an Auto Scaling Group
const asg = new aws.autoscaling.Group("asg", {
    vpcZoneIdentifiers: [publicSubnet.id],
    launchTemplate: {
        id: launchTemplate.id,
        version: "$Latest",
    },
    minSize: 1,
    maxSize: 3,
    desiredCapacity: 2,
    targetGroupArns: [],
});

// Create an Application Load Balancer
const alb = new aws.lb.LoadBalancer("alb", {
    internal: false,
    securityGroups: [albSg.id],
    subnets: [publicSubnet.id, publicSubnet2.id],
});

const httpListener = new aws.lb.Listener("httpListener", {
    loadBalancerArn: alb.arn,
    port: 80,
    defaultActions: [{ type: "fixed-response", fixedResponse: { contentType: "text/plain", statusCode: "200" } }],
});

const httpsListener = new aws.lb.Listener("httpsListener", {
    loadBalancerArn: alb.arn,
    port: 443,
    defaultActions: [{ type: "fixed-response", fixedResponse: { contentType: "text/plain", statusCode: "200" } }],
    certificateArn: certificateValidation.certificateArn,
});

// Create a CloudFront distribution
const distribution = new aws.cloudfront.Distribution("distribution", {
    enabled: true,
    origins: [{
        domainName: alb.dnsName,
        originId: "alb-origin",
    }],
    defaultCacheBehavior: {
        targetOriginId: "alb-origin",
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD"],
        cachedMethods: ["GET", "HEAD"],
        forwardedValues: {
            queryString: false,
            cookies: {
                forward: "none",
            },
        },
    },
    viewerCertificate: {
        acmCertificateArn: certificateValidation.certificateArn,
        sslSupportMethod: "sni-only",
    },
    aliases: [fullDomainName],
    restrictions: {
        geoRestriction: {
            restrictionType: "none",
        },
    },
});

// Create a Route 53 alias record
new aws.route53.Record("aliasRecord", {
    zoneId: zone.then(zone => zone.id),
    name: subdomain,
    type: "A",
    aliases: [{
        name: distribution.domainName,
        zoneId: distribution.hostedZoneId,
        evaluateTargetHealth: true,
    }],
});

// Export the CloudFront distribution domain name
export const distributionDomainName = distribution.domainName;
