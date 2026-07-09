#!/usr/bin/env bash
#
# One-time bootstrap for Root Maze. Creates the staging and prod CloudFormation
# stacks. Run once against the target AWS account with credentials available —
# e.g. in AWS CloudShell, or locally with the AWS CLI configured.
#
#   GOOGLE_CLIENT_ID=your-id.apps.googleusercontent.com bash scripts/setup.sh
#
# After the first run, GitHub Actions takes over deploys via the OIDC roles
# printed at the end.
#
# Env vars:
#   GOOGLE_CLIENT_ID  (required) Google OAuth Web client ID
#   CREATE_OIDC       (optional) 'true' if this AWS account has no GitHub OIDC
#                     provider yet. Default 'false' (log-doom already made one).
#   PROD_DOMAIN       (optional) custom apex domain for prod, e.g. rootmaze.com
#   PROD_CERT_ARN     (optional) ACM cert ARN (us-east-1) for PROD_DOMAIN and
#                     www.PROD_DOMAIN. Get it from scripts/request-cert.sh.
#   GITHUB_ORG        default: differentmatt
#   GITHUB_REPO       default: root-maze

set -euo pipefail

REGION=us-east-1
GITHUB_ORG=${GITHUB_ORG:-differentmatt}
GITHUB_REPO=${GITHUB_REPO:-root-maze}
CREATE_OIDC=${CREATE_OIDC:-false}
: "${GOOGLE_CLIENT_ID:?Set GOOGLE_CLIENT_ID=your-id.apps.googleusercontent.com}"

TEMPLATE="$(dirname "$0")/../infra/template.yaml"
if [ ! -f "$TEMPLATE" ]; then
  echo "Cannot find infra/template.yaml. Run from a clone of the repo, or" >&2
  echo "clone first: git clone https://github.com/$GITHUB_ORG/$GITHUB_REPO" >&2
  exit 1
fi

deploy_stack() {
  local env="$1" stack="$2" ref_pattern="$3" domain="${4:-}" cert="${5:-}"
  echo ">> Deploying $stack ($env) ..."
  aws cloudformation deploy \
    --region "$REGION" \
    --stack-name "$stack" \
    --template-file "$TEMPLATE" \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
      Environment="$env" \
      AllowedRefPattern="$ref_pattern" \
      GoogleClientId="$GOOGLE_CLIENT_ID" \
      GitHubOrg="$GITHUB_ORG" \
      GitHubRepo="$GITHUB_REPO" \
      CreateOIDCProvider="$CREATE_OIDC" \
      DomainName="$domain" \
      CertificateArn="$cert" \
    --no-fail-on-empty-changeset
  # Only the first stack should create the shared OIDC provider.
  CREATE_OIDC=false
}

output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}

deploy_stack staging root-maze-staging '*'
deploy_stack prod    root-maze-prod    'ref:refs/heads/main' \
  "${PROD_DOMAIN:-}" "${PROD_CERT_ARN:-}"

echo
echo "=================================================================="
echo " Done. Put these into GitHub (repo Settings -> Secrets and"
echo " variables -> Actions):"
echo
echo " Secrets:"
echo "   AWS_DEPLOY_ROLE_STAGING = $(output root-maze-staging DeployRoleArn)"
echo "   AWS_DEPLOY_ROLE_PROD    = $(output root-maze-prod DeployRoleArn)"
echo
echo " Variables:"
echo "   VITE_GOOGLE_CLIENT_ID   = $GOOGLE_CLIENT_ID"
echo
echo " Your URLs (add BOTH as Authorized JavaScript origins on the Google"
echo " OAuth client):"
echo "   staging: $(output root-maze-staging SiteUrl)"
echo "   prod:    $(output root-maze-prod SiteUrl)"
echo "=================================================================="
