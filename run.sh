#!/bin/sh

# AWS Profile Switcher with MFA support
# AWS_PROFILE="$AWS_PROFILE" _awsp_prompt
AWS_PROFILE="$AWS_PROFILE"

# Configuration
AWS_REGION="ap-northeast-1"
CREDENTIALS_TEMP_FILE="$HOME/.awsp-credentials"

# Check dependencies
check_dependencies() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq is required but not installed. Please install jq." >&2
    exit 1
  fi
  if ! command -v aws >/dev/null 2>&1; then
    echo "Error: AWS CLI is required but not installed. Please install AWS CLI." >&2
    exit 1
  fi
}

# Assume role with MFA authentication
assume_role_with_mfa() {
  local profile=$1
  local mfa_code=$2
  
  # Get required configuration from AWS config
  local role_arn=$(aws configure get $profile.role_arn 2>/dev/null)
  local mfa_serial=$(aws configure get $profile.mfa_serial 2>/dev/null)
  
  if [ -z "$role_arn" ] || [ -z "$mfa_serial" ]; then
    echo "Error: role_arn or mfa_serial not configured for profile $profile" >&2
    return 1
  fi
  
  # Execute STS AssumeRole
  AWS_STS_CREDENTIALS=$(aws sts assume-role \
    --profile default \
    --role-arn "$role_arn" \
    --role-session-name "$profile-session" \
    --serial-number "$mfa_serial" \
    --token-code "$mfa_code" 2>/dev/null)
  
  if [ $? -ne 0 ]; then
    echo "Error: Failed to assume role. Check your MFA code and try again." >&2
    return 1
  fi
  
  # Extract credentials from response
  AWS_ACCESS_KEY_ID=$(echo "$AWS_STS_CREDENTIALS" | jq -r '.Credentials.AccessKeyId')
  AWS_SECRET_ACCESS_KEY=$(echo "$AWS_STS_CREDENTIALS" | jq -r '.Credentials.SecretAccessKey')
  AWS_SESSION_TOKEN=$(echo "$AWS_STS_CREDENTIALS" | jq -r '.Credentials.SessionToken')
  
  # Copy credentials to clipboard
  clipboard_content="AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY
AWS_REGION=$AWS_REGION
AWS_SESSION_TOKEN=$AWS_SESSION_TOKEN"
  
  echo "$clipboard_content" | pbcopy 2>/dev/null
  if [ $? -eq 0 ]; then
    echo "Credentials copied to clipboard"
  else
    echo "Successfully assumed role (clipboard copy failed)"
  fi
}

# Process credentials from temporary file
process_credentials_file() {
  local credentials_file="$CREDENTIALS_TEMP_FILE"
  local silent_mode="$1"
  
  if [ -f "$credentials_file" ]; then
    if [ "$silent_mode" = "silent" ]; then
      # Silent mode: Load environment variables from temp file
      # (Message and clipboard copy already handled by index.js)
      eval "$(cat "$credentials_file")"
    else
      # Normal mode: Output environment variables for eval
      cat "$credentials_file"
    fi
    rm -f "$credentials_file"
  fi
}

# Check dependencies before proceeding
check_dependencies

# Function to check if input is a Role ARN
is_role_arn() {
  local input="$1"
  if [[ $input =~ ^arn:aws:iam::[0-9]{12}:role/[a-zA-Z0-9+=,.@_/-]+$ ]]; then
    return 0
  else
    return 1
  fi
}

# Function to assume role with direct ARN
assume_role_with_arn() {
  local role_arn="$1"
  local source_profile="$2"
  local mfa_code="$3"
  
  local session_name="awsp-$(date +%s)"
  local role_name="$(basename "$role_arn")"
  
  local assume_command="aws sts assume-role --profile \"$source_profile\" --role-arn \"$role_arn\" --role-session-name \"$session_name\""
  
  # Add MFA if provided
  if [ -n "$mfa_code" ]; then
    local mfa_serial=$(aws configure get $source_profile.mfa_serial 2>/dev/null || aws configure get default.mfa_serial 2>/dev/null)
    if [ -n "$mfa_serial" ]; then
      assume_command="$assume_command --serial-number \"$mfa_serial\" --token-code \"$mfa_code\""
    else
      echo "Error: MFA code provided but no MFA serial found for profile $source_profile" >&2
      return 1
    fi
  fi
  
  # Execute STS AssumeRole
  AWS_STS_CREDENTIALS=$(eval "$assume_command" 2>/dev/null)
  
  if [ $? -ne 0 ]; then
    echo "Error: Failed to assume role $role_name. Check your credentials and try again." >&2
    return 1
  fi
  
  # Extract credentials from response
  AWS_ACCESS_KEY_ID=$(echo "$AWS_STS_CREDENTIALS" | jq -r '.Credentials.AccessKeyId')
  AWS_SECRET_ACCESS_KEY=$(echo "$AWS_STS_CREDENTIALS" | jq -r '.Credentials.SecretAccessKey')
  AWS_SESSION_TOKEN=$(echo "$AWS_STS_CREDENTIALS" | jq -r '.Credentials.SessionToken')
  
  # Copy credentials to clipboard
  clipboard_content="AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY
AWS_REGION=$AWS_REGION
AWS_SESSION_TOKEN=$AWS_SESSION_TOKEN"
  
  echo "$clipboard_content" | pbcopy 2>/dev/null
  if [ $? -eq 0 ]; then
    echo "Successfully assumed role: $role_name (credentials copied to clipboard)"
  else
    echo "Successfully assumed role: $role_name (clipboard copy failed)"
  fi
}

# Parse command line options
mfa_code=""
source_profile=""
while getopts "m:p:" opt; do
  case $opt in
    m)
      mfa_code="$OPTARG"
      ;;
    p)
      source_profile="$OPTARG"
      ;;
    \?)
      echo "Usage: $0 [-m MFA_CODE] [-p SOURCE_PROFILE] [PROFILE_NAME|ROLE_ARN]" >&2
      echo "" >&2
      echo "Options:" >&2
      echo "  -m MFA_CODE        MFA authentication code" >&2
      echo "  -p SOURCE_PROFILE  Source profile to use for AssumeRole (defaults to current AWS_PROFILE or default)" >&2
      echo "" >&2
      echo "Examples:" >&2
      echo "  $0 my-profile                                          # Switch to profile" >&2
      echo "  $0 arn:aws:iam::123456789012:role/MyRole              # Assume role with ARN" >&2
      echo "  $0 -m 123456 arn:aws:iam::123456789012:role/MyRole    # Assume role with MFA" >&2
      echo "  $0 -p source-profile arn:aws:iam::123456789012:role/MyRole  # Assume role with specific source profile" >&2
      exit 1
      ;;
  esac
done

shift $((OPTIND-1))

# Handle command line argument (profile name or role ARN)
if [ $# -ge 1 ]; then
  argument="$1"
  
  # Check if argument is a Role ARN
  if is_role_arn "$argument"; then
    # Role ARN provided
    if [ -z "$source_profile" ]; then
      source_profile="${AWS_PROFILE:-${AWS_DEFAULT_PROFILE:-default}}"
    fi
    
    assume_role_with_arn "$argument" "$source_profile" "$mfa_code"
  else
    # Profile name provided
    if [ -n "$mfa_code" ]; then
      # MFA code provided: execute AssumeRole directly
      assume_role_with_mfa "$argument" "$mfa_code"
    else
      # No MFA code: set profile conventionally
      export AWS_PROFILE="$argument"
      export AWS_DEFAULT_PROFILE="$argument"
      echo "set profile: $AWS_PROFILE"
    fi
  fi
else
  # Interactive mode: run Node.js selector
  CURRENT=$(cd $(dirname $0);pwd)
  "$CURRENT/index.js"

  selected_profile="$(cat ~/.awsp 2>/dev/null)"
  
  if [ -z "$selected_profile" ]; then
    unset AWS_PROFILE
    unset AWS_DEFAULT_PROFILE
  else
    # Check if credentials file exists (MFA processing was done)
    if [ -f "$CREDENTIALS_TEMP_FILE" ]; then
      # MFA processed: load credentials silently (no echo)
      process_credentials_file "silent"
    else
      # No MFA processing: set profile conventionally
      export AWS_PROFILE="$selected_profile"
      export AWS_DEFAULT_PROFILE="$selected_profile"
      echo "set profile: $AWS_PROFILE"
    fi
  fi
fi