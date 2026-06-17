export const LADDER_TIMER_POLICY = {
  totalTimer: {
    startsAtSeconds: 210,
    losesSecondsPerTick: 5,
    gainsSecondsPerTurn: 10,
    capSeconds: 210,
    loseAtSeconds: 0,
  },
  turnTimer: {
    capSeconds: 150,
    losesSecondsPerTick: 5,
    loseAtSeconds: 0,
  },
  practicalInstruction: 'Choose promptly. Slow turns spend the total timer and leave less time on later turns.',
};

export function timerStatusForPrompt({request = null, publicLog = []} = {}) {
  const fromRequest = timerFieldsFromRequest(request);
  const fromLog = timerFieldsFromLog(publicLog, request?.side?.name);
  const status = {
    secondsLeft: fromRequest.secondsLeft ?? fromLog?.secondsLeft ?? null,
    turnSecondsLeft: fromRequest.turnSecondsLeft ?? fromLog?.turnSecondsLeft ?? null,
    source: fromRequest.source ?? fromLog?.source ?? null,
  };
  if (status.secondsLeft === null && status.turnSecondsLeft === null) return null;
  return status;
}

function timerFieldsFromRequest(request) {
  const secondsLeft = numberOrNull(request?.secondsLeft);
  const turnSecondsLeft = numberOrNull(request?.turnSecondsLeft);
  return {
    secondsLeft,
    turnSecondsLeft,
    source: secondsLeft === null && turnSecondsLeft === null ? null : 'request',
  };
}

function timerFieldsFromLog(publicLog, sideName) {
  const ownName = sideName ? escapeRegExp(sideName) : null;
  for (const line of [...publicLog].reverse()) {
    let match = String(line).match(/\|inactive\|Time left: (\d+) sec this turn \| (\d+) sec total/i);
    if (match) {
      return {
        turnSecondsLeft: Number(match[1]),
        secondsLeft: Number(match[2]),
        source: 'private-inactive-log',
      };
    }

    if (ownName) {
      match = String(line).match(new RegExp(`\\[${ownName} has (\\d+)s this turn / (\\d+)s total\\]`, 'i'));
      if (match) {
        return {
          turnSecondsLeft: Number(match[1]),
          secondsLeft: Number(match[2]),
          source: 'public-inactive-log',
        };
      }

      match = String(line).match(new RegExp(`\\|inactive\\|${ownName} has (\\d+) seconds left(?: this turn)?\\.`, 'i'));
      if (match) {
        return {
          turnSecondsLeft: Number(match[1]),
          secondsLeft: null,
          source: 'public-inactive-log',
        };
      }
    }
  }
  return null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
