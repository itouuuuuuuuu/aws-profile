#!/usr/bin/env node

/**
 * AWS Profile Switcher with MFA Support
 * Interactive profile selector with automatic AssumeRole functionality
 * Supports direct role ARN assumption
 */

const fs = require('fs');
const inquirer = require('inquirer');
const { execSync } = require('child_process');

console.log('AWS Profile Switcher');

// Configuration constants
const CONFIG = {
  homeDir: process.env['HOME'],
  awsRegion: 'ap-northeast-1',
  credentialsFile: `${process.env['HOME']}/.awsp-credentials`,
  profileFile: `${process.env['HOME']}/.awsp`,
  awsConfigFile: `${process.env['HOME']}/.aws/config`
};

const REGEX = {
  profile: /\[profile .*]/g,
  bracketsRemoval: /(\[profile )|(\])/g,
  roleArn: /^arn:aws:iam::[0-9]{12}:role\/[a-zA-Z0-9+=,.@_\/-]+$/
};

const DEFAULTS = {
  profile: 'default',
  mfaCodeLength: 6
};

const OP_ITEM_NAME = 'awsp';
const LAST_TOTP_FILE = `${process.env['HOME']}/.awsp-last-totp`;

/**
 * Get last used TOTP from file
 * @returns {string|null} Last used TOTP or null
 */
const getLastUsedTotp = () => {
  try {
    return fs.readFileSync(LAST_TOTP_FILE, 'utf8').trim();
  } catch {
    return null;
  }
};

/**
 * Save last used TOTP to file
 * @param {string} totp - TOTP code to save
 */
const saveLastUsedTotp = (totp) => {
  try {
    fs.writeFileSync(LAST_TOTP_FILE, totp);
  } catch {
    // Ignore errors
  }
};

/**
 * Get credentials from 1Password (fetches all fields in one call)
 * @returns {Object|null} Credentials object or null if failed
 */
const getCredentialsFrom1Password = () => {
  try {
    const result = execSync(
      `op item get ${OP_ITEM_NAME} --fields aws_access_key_id,aws_secret_access_key,mfa_serial --reveal --format json`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const fields = JSON.parse(result);
    const getValue = (label) => fields.find(f => f.label === label)?.value || null;

    const accessKeyId = getValue('aws_access_key_id');
    const secretAccessKey = getValue('aws_secret_access_key');
    const mfaSerial = getValue('mfa_serial');

    if (!accessKeyId || !secretAccessKey) {
      return null;
    }

    return { accessKeyId, secretAccessKey, mfaSerial };
  } catch (error) {
    return null;
  }
};

/**
 * Get TOTP code from 1Password
 * @returns {string|null} TOTP code or null if failed
 */
const getTotpFrom1Password = () => {
  try {
    const result = execSync(`op item get ${OP_ITEM_NAME} --otp`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    return result || null;
  } catch (error) {
    return null;
  }
};

/**
 * Get credentials with 1Password priority and fallback
 * @param {string} profile - AWS profile name for fallback
 * @returns {Object} Credentials object with source indicator
 */
const getCredentials = (profile) => {
  // Try 1Password first
  const opCredentials = getCredentialsFrom1Password();
  if (opCredentials) {
    console.log('Using credentials from 1Password');
    return {
      ...opCredentials,
      source: '1password'
    };
  }

  // Fallback to AWS CLI/credentials file
  console.log('Falling back to ~/.aws/credentials');
  return {
    accessKeyId: null,
    secretAccessKey: null,
    mfaSerial: null,
    source: 'aws-cli'
  };
};

/**
 * Display profile selection prompt
 * @param {string} data - AWS config file content
 * @returns {Promise} Profile selection promise
 */
const promptProfileChoice = (data) => {
  const matches = data.match(REGEX.profile);

  if (!matches) {
    console.log('No profiles found.');
    console.log('Refer to this guide for help on setting up a new AWS profile:');
    console.log('https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-getting-started.html');
    return;
  }

  const profiles = matches.map((match) => {
    return match.replace(REGEX.bracketsRemoval, '');
  });

  profiles.push(DEFAULTS.profile);

  const profileChoice = [
    {
      type: 'list',
      name: 'profile',
      message: 'Choose a profile',
      choices: profiles,
      default: process.env.AWS_DEFAULT_PROFILE || process.env.AWS_PROFILE || DEFAULTS.profile
    }
  ];

  return inquirer.prompt(profileChoice);
};

/**
 * Read AWS configuration file
 * @returns {Promise<string>} Promise resolving to config file content
 */
const readAwsProfiles = () => {
  return new Promise((resolve, reject) => {
    fs.readFile(CONFIG.awsConfigFile, 'utf8', (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
};

/**
 * Write selected profile to configuration file
 * @param {Object} answers - User selection answers
 * @returns {Promise<string>} Promise resolving to selected profile name
 */
const writeToConfig = (answers) => {
  const profileChoice = answers.profile;

  return new Promise((resolve, reject) => {
    fs.writeFile(CONFIG.profileFile, profileChoice, { flag: 'w' }, function (err) {
      if (err) {
        reject(err);
      } else {
        resolve(profileChoice);
      }
    });
  });
};

/**
 * Prompt for MFA code input
 * @returns {Promise<Object>} Promise resolving to MFA code input
 */
const promptMfaCode = () => {
  const mfaQuestion = [
    {
      type: 'input',
      name: 'mfaCode',
      message: 'Enter MFA code:',
      validate: function(value) {
        if (!value || value.length !== DEFAULTS.mfaCodeLength || !/^\d+$/.test(value)) {
          return `Please enter a valid ${DEFAULTS.mfaCodeLength}-digit MFA code`;
        }
        return true;
      }
    }
  ];

  return inquirer.prompt(mfaQuestion);
};

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Get MFA code (1Password TOTP priority, fallback to manual input)
 * @returns {Promise<string>} MFA code
 */
const getMfaCode = async () => {
  // Try 1Password TOTP first
  let totp = getTotpFrom1Password();
  const lastUsedTotp = getLastUsedTotp();

  if (totp) {
    // Check if this TOTP was already used (same code means same 30-second window)
    if (totp === lastUsedTotp) {
      console.log('TOTP code was already used. Waiting for next code (up to 30 seconds)...');
      // Wait up to 30 seconds for a new code
      for (let i = 0; i < 30; i++) {
        process.stdout.write(`\rWaiting for new TOTP code... ${30 - i}s remaining`);
        await sleep(1000);
        const newTotp = getTotpFrom1Password();
        if (newTotp && newTotp !== lastUsedTotp) {
          totp = newTotp;
          console.log('\rNew TOTP code received.                              ');
          break;
        }
      }

      // If still the same, fall back to manual input
      if (totp === lastUsedTotp) {
        console.log('TOTP timeout, falling back to manual input');
        const answer = await promptMfaCode();
        return answer.mfaCode;
      }
    }

    console.log('Using TOTP from 1Password');
    saveLastUsedTotp(totp);
    return totp;
  }

  // Fallback to manual input
  const answer = await promptMfaCode();
  return answer.mfaCode;
};

/**
 * Check if profile has role configuration for AssumeRole
 * @param {string} profile - AWS profile name
 * @returns {boolean} True if profile has role_arn configured
 */
const hasRoleConfiguration = (profile) => {
  try {
    const roleArn = execSync(`aws configure get ${profile}.role_arn`, { encoding: 'utf8' }).trim();
    return !!roleArn;
  } catch (error) {
    return false;
  }
};

/**
 * Get AWS configuration value for a profile
 * @param {string} profile - Profile name
 * @param {string} key - Configuration key
 * @returns {string} Configuration value
 */
const getAwsConfig = (profile, key) => {
  return execSync(`aws configure get ${profile}.${key}`, { encoding: 'utf8' }).trim();
};

/**
 * Check if input string is a valid Role ARN
 * @param {string} input - Input string to check
 * @returns {boolean} True if input is a valid Role ARN
 */
const isRoleArn = (input) => {
  return REGEX.roleArn.test(input);
};

/**
 * Get current AWS profile or default
 * @returns {string} Current AWS profile name
 */
const getCurrentProfile = () => {
  return process.env.AWS_PROFILE || process.env.AWS_DEFAULT_PROFILE || 'default';
};

/**
 * Get MFA serial for a profile, try 1Password first then AWS config
 * @param {string} profile - AWS profile name
 * @returns {string|null} MFA serial ARN or null if not found
 */
const getMfaSerial = (profile) => {
  // Try 1Password first
  const opCredentials = getCredentialsFrom1Password();
  if (opCredentials && opCredentials.mfaSerial) {
    return opCredentials.mfaSerial;
  }

  // Fallback to AWS config
  try {
    // Try profile-specific MFA serial
    return execSync(`aws configure get ${profile}.mfa_serial`, { encoding: 'utf8' }).trim();
  } catch {
    try {
      // Try default profile MFA serial
      return execSync(`aws configure get default.mfa_serial`, { encoding: 'utf8' }).trim();
    } catch {
      // No MFA serial found
      return null;
    }
  }
};

/**
 * Copy credentials to clipboard
 * @param {Object} credentials - AWS credentials
 * @returns {boolean} Success status
 */
const copyToClipboard = (credentials) => {
  const clipboardContent = `AWS_ACCESS_KEY_ID=${credentials.accessKeyId}
AWS_SECRET_ACCESS_KEY=${credentials.secretAccessKey}
AWS_REGION=${CONFIG.awsRegion}
AWS_SESSION_TOKEN=${credentials.sessionToken}`;
  
  try {
    execSync(`echo "${clipboardContent}" | pbcopy`);
    return true;
  } catch (error) {
    return false;
  }
};

/**
 * Perform AWS STS AssumeRole with direct Role ARN
 * @param {string} roleArn - Role ARN to assume
 * @param {string} sourceProfile - Source profile to use for AssumeRole
 * @param {string} mfaCode - MFA authentication code (optional)
 * @returns {boolean} Success status
 */
const performAssumeRoleWithArn = (roleArn, sourceProfile, mfaCode = null) => {
  try {
    // Get credentials (1Password priority with fallback)
    const baseCreds = getCredentials(sourceProfile);

    const sessionName = `awsp-${Date.now()}`;
    let assumeRoleCommand = `aws sts assume-role --role-arn "${roleArn}" --role-session-name "${sessionName}"`;

    // Add MFA if provided
    if (mfaCode) {
      const mfaSerial = baseCreds.mfaSerial || getMfaSerial(sourceProfile);
      if (mfaSerial) {
        assumeRoleCommand += ` --serial-number "${mfaSerial}" --token-code "${mfaCode}"`;
      } else {
        console.error('MFA code provided but no MFA serial found for profile:', sourceProfile);
        return false;
      }
    }

    // Execute with appropriate credentials
    let execOptions = { encoding: 'utf8' };
    if (baseCreds.source === '1password') {
      // Remove existing AWS credentials from env to avoid conflicts
      const cleanEnv = { ...process.env };
      delete cleanEnv.AWS_ACCESS_KEY_ID;
      delete cleanEnv.AWS_SECRET_ACCESS_KEY;
      delete cleanEnv.AWS_SESSION_TOKEN;
      delete cleanEnv.AWS_SECURITY_TOKEN;

      execOptions.env = {
        ...cleanEnv,
        AWS_ACCESS_KEY_ID: baseCreds.accessKeyId,
        AWS_SECRET_ACCESS_KEY: baseCreds.secretAccessKey
      };
    } else {
      // Fallback: use profile
      assumeRoleCommand = `aws sts assume-role --profile "${sourceProfile}" --role-arn "${roleArn}" --role-session-name "${sessionName}"`;
      if (mfaCode) {
        const mfaSerial = getMfaSerial(sourceProfile);
        if (mfaSerial) {
          assumeRoleCommand += ` --serial-number "${mfaSerial}" --token-code "${mfaCode}"`;
        }
      }
    }

    const stsCredentials = execSync(assumeRoleCommand, execOptions);
    const credentials = JSON.parse(stsCredentials);
    
    // Extract credentials
    const creds = {
      accessKeyId: credentials.Credentials.AccessKeyId,
      secretAccessKey: credentials.Credentials.SecretAccessKey,
      sessionToken: credentials.Credentials.SessionToken
    };
    
    // Extract role name from ARN for display
    const roleName = roleArn.split('/').pop();
    
    // Create credentials content for shell export
    const credentialsContent = `export AWS_ACCESS_KEY_ID=${creds.accessKeyId}
export AWS_SECRET_ACCESS_KEY=${creds.secretAccessKey}
export AWS_REGION=${CONFIG.awsRegion}
export AWS_SESSION_TOKEN=${creds.sessionToken}
export AWS_ASSUMED_ROLE_ARN=${roleArn}
export AWS_ASSUMED_ROLE_NAME=${roleName}`;
    
    // Write to temporary file for shell processing
    fs.writeFileSync(CONFIG.credentialsFile, credentialsContent);
    
    // Copy to clipboard and display result
    const clipboardSuccess = copyToClipboard(creds);
    const message = clipboardSuccess 
      ? `Successfully assumed role: ${roleName}`
      : `Successfully assumed role: ${roleName} (clipboard copy failed)`;
    
    console.log(message);
    
    // Display current AWS identity for confirmation
    try {
      console.log('\nCurrent AWS identity:');
      const callerIdentity = execSync('aws sts get-caller-identity --output table 2>/dev/null', { 
        encoding: 'utf8',
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: creds.accessKeyId,
          AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
          AWS_SESSION_TOKEN: creds.sessionToken
        }
      });
      console.log(callerIdentity);
    } catch (error) {
      // Silently ignore errors to avoid disrupting the main flow
    }
    
    return true;
    
  } catch (error) {
    console.error('Error assuming role:', error.message);
    return false;
  }
};

/**
 * Perform AWS STS AssumeRole with MFA
 * @param {string} profile - AWS profile name
 * @param {string} mfaCode - MFA authentication code
 * @returns {boolean} Success status
 */
const performAssumeRole = (profile, mfaCode) => {
  try {
    // Get credentials (1Password priority with fallback)
    const baseCreds = getCredentials(profile);

    // Get role configuration from AWS config
    const roleArn = getAwsConfig(profile, 'role_arn');
    // Use 1Password mfa_serial if available, otherwise from AWS config
    const mfaSerial = baseCreds.mfaSerial || getAwsConfig(profile, 'mfa_serial');

    // Build command and execute
    let assumeRoleCommand;
    let execOptions = { encoding: 'utf8' };

    if (baseCreds.source === '1password') {
      // Use 1Password credentials via environment variables
      // Remove existing AWS credentials from env to avoid conflicts
      const cleanEnv = { ...process.env };
      delete cleanEnv.AWS_ACCESS_KEY_ID;
      delete cleanEnv.AWS_SECRET_ACCESS_KEY;
      delete cleanEnv.AWS_SESSION_TOKEN;
      delete cleanEnv.AWS_SECURITY_TOKEN;

      assumeRoleCommand = `aws sts assume-role --role-arn "${roleArn}" --role-session-name "${profile}-session" --serial-number "${mfaSerial}" --token-code "${mfaCode}"`;
      execOptions.env = {
        ...cleanEnv,
        AWS_ACCESS_KEY_ID: baseCreds.accessKeyId,
        AWS_SECRET_ACCESS_KEY: baseCreds.secretAccessKey
      };
    } else {
      // Fallback: use profile
      assumeRoleCommand = `aws sts assume-role --profile default --role-arn "${roleArn}" --role-session-name "${profile}-session" --serial-number "${mfaSerial}" --token-code "${mfaCode}"`;
    }

    const stsCredentials = execSync(assumeRoleCommand, execOptions);
    const credentials = JSON.parse(stsCredentials);
    
    // Extract credentials
    const creds = {
      accessKeyId: credentials.Credentials.AccessKeyId,
      secretAccessKey: credentials.Credentials.SecretAccessKey,
      sessionToken: credentials.Credentials.SessionToken
    };
    
    // Create credentials content for shell export
    const credentialsContent = `export AWS_ACCESS_KEY_ID=${creds.accessKeyId}
export AWS_SECRET_ACCESS_KEY=${creds.secretAccessKey}
export AWS_REGION=${CONFIG.awsRegion}
export AWS_SESSION_TOKEN=${creds.sessionToken}
export AWS_PROFILE=${profile}
export AWS_DEFAULT_PROFILE=${profile}`;
    
    // Write to temporary file for shell processing
    fs.writeFileSync(CONFIG.credentialsFile, credentialsContent);
    
    // Copy to clipboard and display result
    const clipboardSuccess = copyToClipboard(creds);
    const message = clipboardSuccess 
      ? `Successfully assumed role for profile: ${profile}`
      : `Successfully assumed role for profile: ${profile} (clipboard copy failed)`;
    
    console.log(message);
    
    // Display current AWS identity for confirmation
    try {
      console.log('\nCurrent AWS identity:');
      const callerIdentity = execSync('aws sts get-caller-identity --output table 2>/dev/null', { 
        encoding: 'utf8',
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: creds.accessKeyId,
          AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
          AWS_SESSION_TOKEN: creds.sessionToken
        }
      });
      console.log(callerIdentity);
    } catch (error) {
      // Silently ignore errors to avoid disrupting the main flow
    }
    
    return true;
    
  } catch (error) {
    console.error('Error assuming role:', error.message);
    return false;
  }
};

/**
 * Main application flow
 */
const main = async () => {
  try {
    // Check if Role ARN is provided as command line argument
    const args = process.argv.slice(2);
    const roleArnArg = args.find(arg => isRoleArn(arg));
    
    if (roleArnArg) {
      // Direct Role ARN assumption mode
      const sourceProfile = getCurrentProfile();
      const mfaSerial = getMfaSerial(sourceProfile);
      
      if (mfaSerial) {
        // MFA is required
        try {
          const mfaCode = await getMfaCode();
          const success = performAssumeRoleWithArn(roleArnArg, sourceProfile, mfaCode);

          if (!success) {
            process.exit(1);
          }
        } catch (error) {
          console.error('MFA authentication failed:', error.message);
          process.exit(1);
        }
      } else {
        // No MFA required
        const success = performAssumeRoleWithArn(roleArnArg, sourceProfile);
        
        if (!success) {
          process.exit(1);
        }
      }
      
      return;
    }
    
    // Interactive profile selection mode
    const awsConfig = await readAwsProfiles();
    const profileAnswer = await promptProfileChoice(awsConfig);
    
    if (!profileAnswer) {
      return; // No profiles found
    }
    
    // Write selected profile to config
    const profileChoice = await writeToConfig(profileAnswer);
    
    // Check if profile requires MFA authentication
    if (hasRoleConfiguration(profileChoice)) {
      try {
        const mfaCode = await getMfaCode();
        const success = performAssumeRole(profileChoice, mfaCode);

        if (!success) {
          process.exit(1);
        }
      } catch (error) {
        console.error('MFA authentication failed:', error.message);
        process.exit(1);
      }
    }
    
  } catch (error) {
    console.error('Error:', error.message || error);
    process.exit(1);
  }
};

// Run the application
main();