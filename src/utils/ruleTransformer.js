// src/utils/ruleTransformer.js

/**
 * Build the daily checklist payload from an active ruleset.
 *
 * MINIMUM mode uses only the user's two recovery rules. Previously an
 * unresolvable minimum rule was silently dropped by .filter(Boolean); if all of
 * them dropped, the day was created with zero rules and USP_CLOSE_DAY scored
 * 0 === 0 as PASS — a free pass, and three of those trigger recovery to
 * STANDARD. A Minimum day must never be empty.
 *
 * @param {object} ruleset  GET /ruleset/active payload
 * @param {'STANDARD'|'MINIMUM'} mode
 * @returns {Array<object>} daily rule payloads (never empty for MINIMUM when
 *                          the ruleset has any standard rules)
 */
function transformRulesForDaily(ruleset, mode = 'STANDARD') {
  const standardRules = Array.isArray(ruleset?.standardRules)
    ? ruleset.standardRules
    : [];
  const minimumRules = Array.isArray(ruleset?.minimumRules)
    ? ruleset.minimumRules
    : [];

  let rulesToUse;

  if (mode === 'MINIMUM') {
    rulesToUse = minimumRules
      .map((minRule) => standardRules.find((r) => r.ruleId === minRule.ruleId))
      .filter(Boolean);

    if (rulesToUse.length === 0 && standardRules.length > 0) {
      // Recovery links are broken (renumbered rule ids, partial finalize).
      // Degrade to a reduced bar rather than an empty — and therefore
      // automatically passing — day.
      rulesToUse = standardRules.slice(0, Math.min(2, standardRules.length));
      console.error(
        '[RuleTransformer] MINIMUM mode resolved 0 rules for ruleset ' +
          `${ruleset?.ruleSetId ?? 'unknown'} — falling back to the first ` +
          `${rulesToUse.length} standard rule(s). MINIMUM_RULE rows need repair.`,
      );
    } else if (rulesToUse.length < minimumRules.length) {
      console.warn(
        `[RuleTransformer] MINIMUM mode resolved ${rulesToUse.length}/${minimumRules.length} ` +
          `rules for ruleset ${ruleset?.ruleSetId ?? 'unknown'}.`,
      );
    }
  } else {
    rulesToUse = standardRules;
  }

  return rulesToUse.map((rule) => {
    const dailyRule = {
      ruleId: rule.ruleId,
      domainType: rule.domainType,
      description: rule.description,
      requiredValue: rule.targetValue,
    };

    if (rule.domainType === 'LEARNING' && rule.proofTypes) {
      dailyRule.allowedProofTypes = Array.isArray(rule.proofTypes)
        ? rule.proofTypes.join(',')
        : rule.proofTypes;
    }

    if (rule.domainType === 'REFLECTION') {
      dailyRule.reflectionTiming = rule.reflectionTiming || 'EVENING';
    }

    return dailyRule;
  });
}

module.exports = { transformRulesForDaily };
