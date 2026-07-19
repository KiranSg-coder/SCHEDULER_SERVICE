// src/utils/ruleTransformer.js

function transformRulesForDaily(ruleset, mode = 'STANDARD') {
  // Determine which rules to use
  let rulesToUse;
  
  if (mode === 'MINIMUM') {
    // Use only minimum rules
    rulesToUse = ruleset.minimumRules.map(minRule => {
      return ruleset.standardRules.find(r => r.ruleId === minRule.ruleId);
    }).filter(Boolean); // Remove any undefined
  } else {
    // Use all standard rules
    rulesToUse = ruleset.standardRules;
  }

  // Transform for daily creation
  return rulesToUse.map(rule => {
    const dailyRule = {
      ruleId: rule.ruleId,
      domainType: rule.domainType,
      description: rule.description,
      requiredValue: rule.targetValue,
    };

    // Add LEARNING-specific fields
    if (rule.domainType === 'LEARNING' && rule.proofTypes) {
      dailyRule.allowedProofTypes = Array.isArray(rule.proofTypes)
        ? rule.proofTypes.join(',')
        : rule.proofTypes;
    }

    // Add REFLECTION-specific fields
    if (rule.domainType === 'REFLECTION') {
      dailyRule.reflectionTiming = rule.reflectionTiming || 'EVENING';
    }

    return dailyRule;
  });
}

module.exports = { transformRulesForDaily };