// PROTOTYPE for Wayfinder #15. Pure event-stream observation only.

export const ACTION_TYPES = new Set([
  'pass', 'dribble', 'shot', 'tackle', 'interception', 'foul', 'kickoff', 'whistle',
]);

export function teamOf(id) {
  return typeof id === 'number' ? (id <= 10 ? 'home' : 'away') : null;
}

export function actionTeam(event) {
  if (event.type === 'pass' || event.type === 'kickoff') return teamOf(event.from ?? event.subject);
  if (event.type === 'foul') return teamOf(event.carrier) ?? teamOf(event.subject);
  if (event.type === 'tackle') return teamOf(event.subject);
  if (event.type === 'interception') return teamOf(event.subject);
  return teamOf(event.subject);
}

export function attackingX(team, x) {
  return team === 'home' ? x : 1 - x;
}

export function zoneFor(team, x) {
  if (typeof x !== 'number' || !team) return 'unknown';
  const attacking = attackingX(team, x);
  if (attacking < 1 / 3) return 'own_third';
  if (attacking < 2 / 3) return 'middle_third';
  return 'final_third';
}

export function estimateEndTime(event) {
  if (typeof event.t !== 'number') return null;
  if (typeof event.speed !== 'number' || event.speed <= 0) return event.t;
  if (typeof event.x !== 'number' || typeof event.y !== 'number' ||
      typeof event.x2 !== 'number' || typeof event.y2 !== 'number') return event.t;
  const meters = Math.hypot((event.x2 - event.x) * 105, (event.y2 - event.y) * 68);
  return event.t + Math.max(meters / event.speed, 0.05);
}

function isAction(event) {
  return ACTION_TYPES.has(event?.type);
}

function resultOf(event) {
  if (event.type === 'foul') return event.card ? `foul_${event.card}` : 'foul';
  return event.result ?? 'none';
}

function phaseFor(event, team, previousTeam) {
  if (event.detail === 'corner' || event.detail === 'throw_in' || event.detail === 'free_kick') return 'set_piece';
  if (event.type === 'tackle' || event.type === 'interception') {
    return previousTeam && previousTeam !== team ? 'attacking_transition' : 'defensive_transition';
  }
  if (event.type === 'shot') return 'final_third';
  if (previousTeam && previousTeam !== team) return 'attacking_transition';
  const zone = zoneFor(team, event.x);
  if (zone === 'own_third') return 'build_up';
  if (zone === 'final_third') return 'final_third';
  if (zone === 'middle_third') return 'progression';
  return 'unknown';
}

function changeFor(event, previousTeam, team) {
  if (event.type === 'whistle') return 'dead_ball';
  if (event.type === 'interception' || event.type === 'tackle') {
    return previousTeam && previousTeam !== team ? 'won' : 'none';
  }
  if (event.type === 'pass' && event.result === 'intercepted') return 'lost';
  if (event.type === 'pass' && event.result === 'lost') return 'contested';
  if (event.type === 'pass' && event.result === 'out') return 'dead_ball';
  if (event.type === 'shot') return 'dead_ball';
  if (event.type === 'foul') return 'dead_ball';
  return previousTeam && previousTeam !== team ? 'won' : 'none';
}

function shouldClose(event) {
  return event.type === 'whistle' || event.type === 'shot' || event.type === 'foul' ||
    (event.type === 'pass' && (event.result === 'out' || event.detail === 'corner'));
}

function closeSegment(segments, state, endTime, reason) {
  if (!state.current) return;
  state.current.end_t = Math.max(state.current.start_t, endTime ?? state.current.start_t);
  state.current.end_reason = reason;
  state.current.action_count = state.current.actions.length;
  segments.push(state.current);
  state.current = null;
}

function openSegment(state, team, time, reason) {
  state.current = {
    id: state.nextId++,
    team,
    start_t: time,
    end_t: null,
    start_reason: reason,
    end_reason: null,
    actions: [],
    phase_segments: [],
  };
}

export function observeMatch(events, { duration = null } = {}) {
  const segments = [];
  const observations = [];
  const state = { current: null, nextId: 0, previousTeam: null };

  (events ?? []).forEach((event, index) => {
    if (!isAction(event)) return;
    const team = actionTeam(event);
    const endTime = estimateEndTime(event) ?? event.t;
    if (!team) {
      observations.push({ event_index: index, t_start: event.t, t_end: endTime, possession_id: null, possession_team: null, phase: 'unknown', zone: 'unknown', action_kind: event.type, action_result: resultOf(event), possession_change: 'unknown', chain_index: null });
      return;
    }

    const changed = state.previousTeam && state.previousTeam !== team;
    if (!state.current) openSegment(state, team, event.t, event.type === 'kickoff' ? 'kickoff' : 'inferred');
    else if (changed && (event.type === 'tackle' || event.type === 'interception' || event.type === 'pass')) {
      closeSegment(segments, state, event.t, 'control_change');
      openSegment(state, team, event.t, event.type);
    }

    const phase = phaseFor(event, team, state.previousTeam);
    const zone = zoneFor(team, event.x);
    const possessionChange = changeFor(event, state.previousTeam, team);
    const observation = {
      event_index: index,
      t_start: event.t,
      t_end: endTime,
      possession_id: state.current?.id ?? null,
      possession_team: state.current?.team ?? team,
      phase,
      zone,
      action_kind: event.type,
      action_result: resultOf(event),
      possession_change: possessionChange,
      chain_index: state.current ? state.current.actions.length : null,
    };
    observations.push(observation);
    state.current.actions.push(observation);
    state.current.phase_segments.push({ phase, start_t: event.t, end_t: endTime });

    state.previousTeam = team;
    if (shouldClose(event)) {
      const reason = event.type === 'shot' ? 'shot' : event.type === 'foul' ? 'foul_restart' : event.detail === 'corner' ? 'corner' : event.result === 'out' ? 'out' : 'whistle';
      closeSegment(segments, state, endTime, reason);
      if (event.type === 'foul' || event.detail === 'corner') state.previousTeam = team;
    }
  });

  closeSegment(segments, state, duration ?? null, 'end_of_stream');
  return { observations, possessions: segments };
}
