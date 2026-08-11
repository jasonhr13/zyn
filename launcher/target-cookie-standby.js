'use strict';

function targetGroupStandbyTaskCount(groups) {
  return (Array.isArray(groups) ? groups : []).reduce((maximum, group) => {
    if (String((group && group.site) || 'target').toLowerCase() !== 'target') return maximum;
    const tasks = Array.isArray(group && group.tasks) ? group.tasks : [];
    return Math.max(maximum, tasks.length);
  }, 0);
}

module.exports = { targetGroupStandbyTaskCount };
