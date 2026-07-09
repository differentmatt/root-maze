#!/usr/bin/env bash
#
# Request an ACM certificate (us-east-1, DNS-validated) for a custom domain
# and its www subdomain, then print the DNS validation records to add at your
# DNS host. Run once when attaching a custom domain to the prod stack.
#
#   bash scripts/request-cert.sh rootmaze.com
#
# After adding the printed validation records (as DNS-only / unproxied CNAMEs),
# wait for the cert to be issued, then redeploy prod with the domain:
#
#   aws acm wait certificate-validated --region us-east-1 --certificate-arn <ARN>
#   GOOGLE_CLIENT_ID=... PROD_DOMAIN=rootmaze.com PROD_CERT_ARN=<ARN> \
#     bash scripts/setup.sh

set -euo pipefail

REGION=us-east-1
DOMAIN="${1:-${DOMAIN:-}}"
: "${DOMAIN:?Usage: bash scripts/request-cert.sh <domain>   e.g. rootmaze.com}"

echo ">> Requesting certificate for $DOMAIN and www.$DOMAIN ..."
ARN=$(aws acm request-certificate \
  --region "$REGION" \
  --domain-name "$DOMAIN" \
  --subject-alternative-names "www.$DOMAIN" \
  --validation-method DNS \
  --query CertificateArn --output text)
echo "Certificate ARN: $ARN"
echo

# Validation records populate a moment after the request; poll briefly.
echo ">> DNS validation records — add these at your DNS host as CNAME,"
echo "   DNS-only (Cloudflare: grey cloud, NOT proxied):"
for _ in 1 2 3 4 5 6; do
  ROWS=$(aws acm describe-certificate --region "$REGION" --certificate-arn "$ARN" \
    --query "Certificate.DomainValidationOptions[].ResourceRecord" --output text)
  [ -n "$ROWS" ] && break
  sleep 5
done
aws acm describe-certificate --region "$REGION" --certificate-arn "$ARN" \
  --query "Certificate.DomainValidationOptions[].ResourceRecord" --output table

echo
echo "Next:"
echo "  1. Add the record(s) above at your DNS host (DNS-only)."
echo "  2. aws acm wait certificate-validated --region $REGION --certificate-arn $ARN"
echo "  3. GOOGLE_CLIENT_ID=<id> PROD_DOMAIN=$DOMAIN PROD_CERT_ARN=$ARN bash scripts/setup.sh"
echo "  4. Point $DOMAIN and www.$DOMAIN at the prod CloudFront domain (DNS-only)."
