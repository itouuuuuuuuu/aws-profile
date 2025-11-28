# AWSP - AWS Profile Switcher with MFA Support

Easily switch between AWS Profiles with automatic MFA-enabled AssumeRole functionality

<img src="demo.gif" width="500">

## Features

- 🔀 Interactive AWS profile switching
- 🔐 Automatic MFA-enabled AssumeRole for configured profiles
- 🔑 **1Password integration** for secure credential and TOTP management
- 🎯 Direct Role ARN assumption without pre-configured profiles
- 📋 Automatic clipboard copy of credentials
- ⚡ Environment variable export for immediate use

## Prerequisites

### Dependencies
- **AWS CLI**: For profile management and STS operations
- **jq**: For JSON parsing (install via `brew install jq` on macOS)
- **Node.js**: For the interactive interface
- **pbcopy**: For clipboard functionality (available on macOS by default)
- **1Password CLI (op)**: For secure credential management (optional but recommended)

### AWS Profile Setup
Setup your profiles using the AWS CLI:

```sh
# Basic profile setup
aws configure --profile PROFILE_NAME

# Or set default credentials
aws configure
```

For more information: https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-getting-started.html

### 1Password Setup (Recommended)

AWSP can retrieve AWS credentials and TOTP codes directly from 1Password, eliminating the need to store credentials in `~/.aws/credentials` and manually enter MFA codes.

#### 1. Install 1Password CLI

```sh
# macOS
brew install --cask 1password-cli
```

#### 2. Create a 1Password Item

Create an item named `awsp` in 1Password with the following fields:

| Field | Value |
|-------|-------|
| `aws_access_key_id` | Your AWS Access Key ID |
| `aws_secret_access_key` | Your AWS Secret Access Key |
| `mfa_serial` | Your MFA device ARN (e.g., `arn:aws:iam::123456789012:mfa/username`) |
| One-time password | Configure TOTP with your AWS MFA secret |

#### 3. Enable 1Password CLI Integration

Ensure you're signed in to 1Password CLI:
```sh
op signin
```

With this setup, AWSP will:
- Automatically retrieve AWS credentials from 1Password
- Automatically retrieve TOTP codes (no manual MFA entry required)
- Fall back to `~/.aws/credentials` if 1Password is unavailable

### MFA Configuration
For profiles requiring AssumeRole with MFA, add the following to your AWS config (`~/.aws/config`):

```ini
[profile my-role-profile]
role_arn = arn:aws:iam::123456789012:role/MyRole
source_profile = default

[profile another-role]
role_arn = arn:aws:iam::987654321098:role/AnotherRole
source_profile = default
```

Note: When using 1Password, `mfa_serial` is retrieved from 1Password automatically.

## Setup

```sh
npm install -g awsp
```

Add the following to your `.bashrc` or `.zshrc` config:
```sh
alias awsp="source _awsp"
```

## Usage

### Interactive Mode (Recommended)
```sh
awsp
```
- Displays a list of available AWS profiles
- For MFA-enabled profiles:
  - With 1Password: Automatically retrieves TOTP and assumes role (no manual input required)
  - Without 1Password: Prompts for MFA code
- Credentials are automatically copied to clipboard

### Direct Role ARN Assumption

Assume roles directly by specifying a Role ARN without pre-configured profiles:

```sh
# Assume role with automatic MFA (TOTP from 1Password)
awsp arn:aws:iam::123456789012:role/MyRole
```

This feature is particularly useful for:
- Temporary role assumptions without modifying AWS config files
- Cross-account access with dynamically provided Role ARNs

### Usage Examples

**With 1Password Integration (Automatic TOTP):**
```sh
$ awsp
AWS Profile Switcher
? Choose a profile my-role-profile
Using TOTP from 1Password
Using credentials from 1Password
Successfully assumed role for profile: my-role-profile

Current AWS identity:
---------------------------------------------------------------------------------------
|                                  GetCallerIdentity                                  |
+---------+---------------------------------------------------------------------------+
|  Account|  123456789012                                                             |
|  Arn    |  arn:aws:sts::123456789012:assumed-role/MyRole/my-role-profile-session    |
+---------+---------------------------------------------------------------------------+
```

**Switching Profiles Quickly:**

When switching profiles within the same 30-second TOTP window, AWSP automatically waits for a new code:
```sh
$ awsp
AWS Profile Switcher
? Choose a profile another-profile
TOTP code was already used. Waiting for next code (up to 30 seconds)...
Waiting for new TOTP code... 15s remaining
New TOTP code received.
Using credentials from 1Password
Successfully assumed role for profile: another-profile
```

**Without 1Password (Manual MFA):**
```sh
$ awsp
AWS Profile Switcher
? Choose a profile my-role-profile
Falling back to ~/.aws/credentials
? Enter MFA code: 123456
Successfully assumed role for profile: my-role-profile
```

**Direct Role ARN Assumption:**
```sh
$ awsp arn:aws:iam::123456789012:role/MyRole
AWS Profile Switcher
Using TOTP from 1Password
Using credentials from 1Password
Successfully assumed role: MyRole
```

## How It Works

### Credential Resolution Order
1. **1Password** (if available): Retrieves `aws_access_key_id`, `aws_secret_access_key`, and `mfa_serial`
2. **~/.aws/credentials** (fallback): Uses AWS CLI's credential chain

### TOTP Resolution Order
1. **1Password** (if configured): Automatically retrieves TOTP code
2. **Manual input** (fallback): Prompts for MFA code entry

### Session Credentials

When a role is assumed:
1. Temporary credentials are obtained via STS AssumeRole
2. Credentials are exported as environment variables
3. Credentials are copied to clipboard in the format:
   ```
   AWS_ACCESS_KEY_ID=ASIA...
   AWS_SECRET_ACCESS_KEY=...
   AWS_REGION=ap-northeast-1
   AWS_SESSION_TOKEN=...
   ```

## Show your AWS Profile in your shell prompt

For better visibility into what your shell is set to, it's helpful to configure your prompt to show the value of the env variable `AWS_PROFILE`.

<img src="screenshot.png" width="300">

Here's a sample of my zsh prompt config using oh-my-zsh themes:

```sh
function aws_prof {
  local profile="${AWS_PROFILE:=default}"

  echo "%{$fg_bold[blue]%}aws:(%{$fg[yellow]%}${profile}%{$fg_bold[blue]%})%{$reset_color%} "
}
```

```sh
PROMPT='OTHER_PROMPT_STUFF $(aws_prof)'
```

## Troubleshooting

### Common Issues

**"1Password credentials not found"**
- Ensure the 1Password item is named exactly `awsp`
- Verify field names: `aws_access_key_id`, `aws_secret_access_key`, `mfa_serial`
- Check that you're signed in: `op signin`

**"TOTP code was already used"**
- This is normal when switching profiles quickly
- AWSP automatically waits for the next 30-second TOTP window

**"jq: command not found"**
```sh
# macOS
brew install jq

# Ubuntu/Debian
sudo apt-get install jq
```

**"Failed to assume role"**
- Verify your credentials are valid
- Ensure the IAM role trusts your user/account
- Check that the role ARN is correct

## Security Notes

- **1Password integration**: Credentials are retrieved on-demand and never stored locally
- **TOTP tracking**: Only the last used TOTP code is stored (`~/.awsp-last-totp`) to prevent reuse
- **Temporary credentials**: Written to `~/.awsp-credentials` and immediately deleted after use
- **No credential logging**: MFA codes and credentials are not logged anywhere
- **Clean environment**: Existing AWS credentials are cleared before assuming roles to prevent conflicts
