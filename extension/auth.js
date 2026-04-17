// auth.js — Cognito User Pool client (USER_PASSWORD_AUTH flow).
//
// Talks to cognito-idp.{region}.amazonaws.com directly via the
// AWSCognitoIdentityProviderService JSON RPC. No SDK required.
//
// Tokens are stored in chrome.storage.local under `greenlit_tokens`.

const STORAGE_KEY = 'greenlit_tokens';
// `cfg` is declared in config.js and shared across this context.

function endpoint() {
  return `https://cognito-idp.${cfg().cognitoRegion}.amazonaws.com/`;
}

async function cognito(target, body) {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || data?.__type || `Cognito ${target} failed`;
    const err = new Error(msg);
    err.code = data?.__type;
    throw err;
  }
  return data;
}

async function saveTokens(authResult) {
  const tokens = {
    idToken:      authResult.IdToken,
    accessToken:  authResult.AccessToken,
    refreshToken: authResult.RefreshToken,
    expiresAt:    Date.now() + (authResult.ExpiresIn - 60) * 1000,
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: tokens });
  return tokens;
}

async function loadTokens() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || null;
}

self.GreenlitAuth = {
  async signUp(email, password) {
    await cognito('SignUp', {
      ClientId: cfg().cognitoClientId,
      Username: email,
      Password: password,
      UserAttributes: [{ Name: 'email', Value: email }],
    });
  },

  async confirmSignUp(email, code) {
    await cognito('ConfirmSignUp', {
      ClientId:         cfg().cognitoClientId,
      Username:         email,
      ConfirmationCode: code,
    });
  },

  async resendConfirmationCode(email) {
    await cognito('ResendConfirmationCode', {
      ClientId: cfg().cognitoClientId,
      Username: email,
    });
  },

  async forgotPassword(email) {
    await cognito('ForgotPassword', {
      ClientId: cfg().cognitoClientId,
      Username: email,
    });
  },

  async confirmForgotPassword(email, code, newPassword) {
    await cognito('ConfirmForgotPassword', {
      ClientId:         cfg().cognitoClientId,
      Username:         email,
      ConfirmationCode: code,
      Password:         newPassword,
    });
  },

  async signIn(email, password) {
    const data = await cognito('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: cfg().cognitoClientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    });
    if (!data.AuthenticationResult) {
      throw new Error('Sign-in did not return tokens (challenge required?)');
    }
    return saveTokens(data.AuthenticationResult);
  },

  async signOut() {
    await chrome.storage.local.remove(STORAGE_KEY);
  },

  async getValidIdToken() {
    let tokens = await loadTokens();
    if (!tokens) return null;
    if (Date.now() < tokens.expiresAt) return tokens.idToken;

    // Refresh
    try {
      const data = await cognito('InitiateAuth', {
        AuthFlow:       'REFRESH_TOKEN_AUTH',
        ClientId:       cfg().cognitoClientId,
        AuthParameters: { REFRESH_TOKEN: tokens.refreshToken },
      });
      if (!data.AuthenticationResult) throw new Error('No refresh result');
      // Refresh response doesn't include a new refresh token — keep the old one.
      const refreshed = await saveTokens({
        ...data.AuthenticationResult,
        RefreshToken: tokens.refreshToken,
      });
      return refreshed.idToken;
    } catch (err) {
      console.warn('[Greenlit] Token refresh failed, signing out.', err);
      await chrome.storage.local.remove(STORAGE_KEY);
      return null;
    }
  },

  async isSignedIn() {
    const tokens = await loadTokens();
    return !!tokens?.refreshToken;
  },
};
