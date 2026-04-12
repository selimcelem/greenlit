// Greenlit endpoint config.
//
// Replace these placeholders with the values printed by `terraform apply`
// in /infra. They're imported by background.js, popup.js, and auth.js.
self.GREENLIT_CONFIG = {
  apiBaseUrl:        'https://REPLACE_ME.execute-api.eu-central-1.amazonaws.com',
  cognitoRegion:     'eu-central-1',
  cognitoClientId:   'REPLACE_ME',
  cognitoUserPoolId: 'REPLACE_ME',
};
