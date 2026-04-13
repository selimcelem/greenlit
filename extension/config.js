// Greenlit endpoint config.
//
// Replace these placeholders with the values printed by `terraform apply`
// in /infra. They're imported by background.js, popup.js, and auth.js.
self.GREENLIT_CONFIG = {
  apiBaseUrl:        'https://6lf8fqecmb.execute-api.eu-central-1.amazonaws.com',
  cognitoRegion:     'eu-central-1',
  cognitoClientId:   '28s5p866gvadgm5pof9thj6ucb',
  cognitoUserPoolId: 'eu-central-1_FUpPaZIby',
};

// Shared helper — declared once so auth.js, background.js, and popup.js
// can all reference `cfg()` without re-declaring it in their own scope.
// (Service worker importScripts + popup <script> tags share a single
// top-level scope per context, so duplicate `const` declarations collide.)
const cfg = () => self.GREENLIT_CONFIG;
