variable "aws_profile" {}

provider "aws" {
  region = "ap-northeast-1"

  profile = var.aws_profile
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"

  tags = {
    Name = "vpc-handson"
  }


}