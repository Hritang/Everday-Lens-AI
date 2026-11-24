const { mkdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

module.exports = function withUsbBackend(config) {
  const useUsb = !process.env.EXPO_PUBLIC_API_BASE_URL?.startsWith('https://');

  config = withAndroidManifest(config, config => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    const attribute = 'android:networkSecurityConfig';
    const usbConfig = '@xml/usb_backend_security';
    if (useUsb) application.$[attribute] = usbConfig;
    else if (application.$[attribute] === usbConfig) delete application.$[attribute];
    return config;
  });

  if (!useUsb) return config;
  return withDangerousMod(config, ['android', async config => {
    const directory = join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'usb_backend_security.xml'), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
  </domain-config>
</network-security-config>
`);
    return config;
  }]);
};
