// RNFB 23.5 has no Analytics Expo plugin. This sets its documented Podfile flag.
const { withPodfile } = require("expo/config-plugins");
module.exports = function withFirebaseAnalyticsNoAdId(config) {
  return withPodfile(config, config => {
    const flag = "$RNFirebaseAnalyticsWithoutAdIdSupport = true";
    if (!config.modResults.contents.includes(flag)) {
      config.modResults.contents = flag + "\n" + config.modResults.contents;
    }
    return config;
  });
};
