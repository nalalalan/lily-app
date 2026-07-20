(function attachLilyWeightCoach(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LilyWeightCoach = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createLilyWeightCoach() {
  "use strict";

  const DAY_MS = 24 * 60 * 60 * 1000;
  const NUMBER_WORDS = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT"];

  function trimWeight(value) {
    if (!Number.isFinite(Number(value))) return "--";
    return Number(Number(value).toFixed(1)).toString();
  }

  function numberWord(value) {
    return NUMBER_WORDS[value] || String(value);
  }

  function spokenNumber(value) {
    return numberWord(value).toLowerCase();
  }

  function dayLabel(day) {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC"
    }).format(new Date(day * DAY_MS));
  }

  function normalize(points) {
    return (Array.isArray(points) ? points : [])
      .map((point) => ({
        day: Number(point && point.day),
        time: Number(point && point.time),
        weight: Number(point && point.weight)
      }))
      .filter((point) => Number.isFinite(point.day) && Number.isFinite(point.weight) && point.weight > 0)
      .sort((left, right) => left.day - right.day || left.time - right.time);
  }

  function analyze(inputPoints, forecast) {
    const points = normalize(inputPoints);
    if (!points.length) return null;
    const latest = points[points.length - 1];
    const changes = [];
    for (let index = 1; index < points.length; index += 1) {
      changes.push({
        change: points[index].weight - points[index - 1].weight,
        gap: points[index].day - points[index - 1].day,
        older: points[index - 1],
        newer: points[index]
      });
    }

    let direction = 0;
    let transitionCount = 0;
    let streakStart = latest;
    const streakChanges = [];
    for (let index = changes.length - 1; index >= 0; index -= 1) {
      const row = changes[index];
      if (row.gap < 1 || row.gap > 2 || Math.abs(row.change / row.gap) < 0.1 || Math.abs(row.change / row.gap) > 2.5) break;
      const rowDirection = Math.sign(row.change);
      if (!direction) direction = rowDirection;
      if (rowDirection !== direction) break;
      transitionCount += 1;
      streakStart = row.older;
      streakChanges.unshift(row.change);
    }

    const totalChange = latest.weight - streakStart.weight;
    const totalMovement = Math.abs(totalChange);
    const recentChange = changes.length ? changes[changes.length - 1].change : 0;
    const movementGrowing = streakChanges.length >= 3 && streakChanges.slice(1).every((change, index) => (
      Math.abs(change) >= Math.abs(streakChanges[index]) + 0.049
    ));
    let state = "flat-noisy";
    if (direction < 0 && transitionCount >= 3 && totalMovement >= 0.8) {
      state = movementGrowing ? "accelerating-loss" : "steady-loss";
    } else if (direction < 0 && transitionCount >= 2 && totalMovement >= 0.5) {
      state = "steady-loss";
    } else if (recentChange <= -0.3) {
      state = "turning-loss";
    } else if (direction > 0 && transitionCount >= 3 && totalMovement >= 0.8) {
      state = movementGrowing ? "accelerating-gain" : "steady-gain";
    } else if (direction > 0 && transitionCount >= 2 && totalMovement >= 0.5) {
      state = "steady-gain";
    } else if (recentChange >= 0.3) {
      state = "turning-gain";
    }

    const seed = Math.abs(Math.round(latest.day + latest.weight * 10 + points.length * 17));
    return {
      state,
      seed,
      pointCount: points.length,
      latestDay: latest.day,
      latestWeight: latest.weight,
      startDay: streakStart.day,
      startWeight: streakStart.weight,
      transitionCount,
      weighInCount: transitionCount + 1,
      durationDays: latest.day - streakStart.day,
      totalChange,
      totalMovement,
      recentChange,
      streakChanges,
      movementGrowing,
      oneYearWeight: Number(forecast && forecast.oneYearWeight)
    };
  }

  function acceleratingLossCopy(read) {
    const count = numberWord(read.weighInCount);
    const start = trimWeight(read.startWeight);
    const latest = trimWeight(read.latestWeight);
    const days = read.durationDays === 1 ? "one day" : `${spokenNumber(read.durationDays)} days`;
    const forecast = trimWeight(read.oneYearWeight);
    const growing = read.movementGrowing ? ", and every drop got bigger" : "";
    return [
      `${numberWord(read.transitionCount)} DROPS IN A ROW—${start} → ${latest} lb in ${days}. The scale is moving with PURPOSE now. Protect this streak, repeat what worked, and go earn the next lower number—WEOOOOOOOOO!`,
      `${count} LOWER WEIGH-INS IN A ROW—${start} → ${latest} lb in ${days}${growing}. THIS is the turn we wanted. Lock in the routine, protect the streak, and make the next weigh-in number ${spokenNumber(read.weighInCount + 1)}—WEOOOOOOOOOOOOO!`,
      `LILY IS MOVING!!! ${start} → ${latest} lb since ${dayLabel(read.startDay)}, with ${read.transitionCount} straight drops. The 1-year forecast just charged to ${forecast} lb. Keep the day tight and make this run impossible to ignore!`,
      `THIS RUN IS AWESOME—${trimWeight(read.totalMovement)} lb down across ${read.weighInCount} weigh-ins. The newest drop was ${trimWeight(Math.abs(read.recentChange))} lb, so the momentum is getting LOUD. Same focus today; next lower weigh-in, let’s gooooo!`,
      `Okay, THIS is what progress looks like: ${count} lower weigh-ins, ${trimWeight(read.totalMovement)} lb gone in ${days}, and the forecast is responding hard. Do not coast—repeat the winning basics and keep the streak alive!`,
      `THE SCALE FINALLY BROKE OUR WAY!!! ${start} → ${latest} lb, ${read.transitionCount} drops without a bounce. That is a real momentum swing. Stay sharp today and chase weigh-in ${read.weighInCount + 1}—WE’RE ROLLING!`
    ][read.seed % 6];
  }

  function steadyLossCopy(read) {
    const facts = `${trimWeight(read.startWeight)} → ${trimWeight(read.latestWeight)} lb`;
    return [
      `${numberWord(read.transitionCount)} STRAIGHT DROPS—${facts}. This is clean, repeatable progress. Keep the routine boring and strong; another lower weigh-in turns a good run into a serious one!`,
      `${trimWeight(read.totalMovement)} lb down since ${dayLabel(read.startDay)}—YES. The direction is right and the streak is alive. Stay on it today and make the next number confirm the move!`,
      `The scale keeps stepping down: ${facts}. That is exactly the pattern we want. Protect it with one more focused day—no victory lap yet!`,
      `Momentum check: ${read.weighInCount} lower weigh-ins and ${trimWeight(read.totalMovement)} lb down. GOOD WORK. Now make it undeniable with the next weigh-in!`,
      `${facts} across ${read.weighInCount} weigh-ins—Lily is building something here. Keep today simple, controlled, and consistent. Let’s stack another win!`,
      `Another lower number, another piece of proof. ${trimWeight(read.totalMovement)} lb down in this run and the forecast is following. KEEP GOING!`
    ][read.seed % 6];
  }

  function turningLossCopy(read) {
    return [
      `YES—${trimWeight(Math.abs(read.recentChange))} lb down on the newest weigh-in. That breaks the wrong direction, but one drop is the opening move. Back it up with another focused day!`,
      `The newest number came down to ${trimWeight(read.latestWeight)} lb. Good turn. Now protect it—one more lower weigh-in makes momentum, not just a moment!`,
      `That ${trimWeight(Math.abs(read.recentChange))}-lb drop got my attention. The scale finally leaned the right way. Stay disciplined today and make it the start of a streak!`,
      `A lower weigh-in—GOOD. The comeback has a first step now. Repeat what worked and force the next number to confirm it!`,
      `${trimWeight(read.latestWeight)} lb, down ${trimWeight(Math.abs(read.recentChange))} from the last check. This is the response we needed. Do it again before we celebrate the full turn!`,
      `The scale just gave us an opening: ${trimWeight(Math.abs(read.recentChange))} lb down. Take it. One strong day, one more lower number, and this story changes fast!`
    ][read.seed % 6];
  }

  function gainCopy(read, accelerating) {
    const count = numberWord(read.weighInCount);
    const facts = `${trimWeight(read.startWeight)} → ${trimWeight(read.latestWeight)} lb`;
    const speed = accelerating && read.movementGrowing ? " and the jumps are getting larger" : "";
    return [
      `Okay—eyes up. ${count} higher weigh-ins in a row: ${facts}${speed}. Do not hand this trend another day—reset one controllable thing now and make the next weigh-in the break in the streak.`,
      `This needs a response: ${trimWeight(read.totalMovement)} lb up since ${dayLabel(read.startDay)}. No shame, no drama—just urgency. Plan the next meal or take a walk, then stop the streak at the next weigh-in.`,
      `${facts}, moving the wrong way across ${read.weighInCount} weigh-ins. Catch it NOW. Choose one concrete reset today and make the next number prove the turn.`,
      `The scale is climbing and I am not letting it slide: ${count} higher weigh-ins, ${trimWeight(read.totalMovement)} lb up. Tighten the next decision, move today, and break this run immediately.`,
      `RED ALERT ON THE TREND—not on Lily. ${facts} in ${read.durationDays} days. The answer is action: one planned meal, one walk, and a hard stop to this streak at the next check.`,
      `We have a live upward streak: ${trimWeight(read.totalMovement)} lb across ${read.weighInCount} weigh-ins. Face it, fix one thing today, and make tomorrow the pivot. The next number matters!`
    ][read.seed % 6];
  }

  function turningGainCopy(read) {
    return [
      `Up ${trimWeight(read.recentChange)} lb on the newest weigh-in. One jump is not a trend, but it earns attention. Reset one controllable choice today and do not let it become two.`,
      `${trimWeight(read.latestWeight)} lb today, a ${trimWeight(read.recentChange)}-lb rise. Catch it early—plan the next meal or get a walk in, then look for the immediate bounce back.`,
      `The latest number moved up ${trimWeight(read.recentChange)} lb. No panic, but no shrug either. Make one strong adjustment today and keep this from becoming a streak.`,
      `A bump to ${trimWeight(read.latestWeight)} lb. Treat it like a warning shot, not a verdict. Win the next 24 hours and make the next weigh-in answer back.`,
      `Newest read: +${trimWeight(read.recentChange)} lb. I’m watching it. Tighten one thing now and stop a one-day rise from growing legs.`,
      `That ${trimWeight(read.recentChange)}-lb increase needs a quick response. Keep it practical: one planned choice, one bit of movement, then hunt the reversal.`
    ][read.seed % 6];
  }

  function flatNoisyCopy(read) {
    return [
      `The scale is bouncing without a clean direction yet. Do not chase one noisy number—stack one focused day and make the next weigh-in give us a stronger signal.`,
      `${trimWeight(read.latestWeight)} lb today, but no honest streak to call. Stay steady, control the controllables, and give the trend a reason to move.`,
      `No clear run yet—just scale noise. This is where consistency wins. One planned meal, one walk, one solid day; then we read the next number.`,
      `The trend is undecided, so today gets to cast the deciding vote. Keep the routine clean and make the next weigh-in more useful than the last.`,
      `Holding around ${trimWeight(read.latestWeight)} lb. Maintenance takes control, but if the goal is down, now is the time to tighten one repeatable habit and create movement.`,
      `Up, down, sideways—the scale has not committed. Lily can. Win the next 24 hours and force a clearer direction at the next check.`
    ][read.seed % 6];
  }

  function compose(read) {
    if (!read) return "Save a weigh-in and I’ll read the momentum.";
    if (read.state === "accelerating-loss") return acceleratingLossCopy(read);
    if (read.state === "steady-loss") return steadyLossCopy(read);
    if (read.state === "turning-loss") return turningLossCopy(read);
    if (read.state === "accelerating-gain") return gainCopy(read, true);
    if (read.state === "steady-gain") return gainCopy(read, false);
    if (read.state === "turning-gain") return turningGainCopy(read);
    return flatNoisyCopy(read);
  }

  function buildCoachRead(points, forecast) {
    return compose(analyze(points, forecast));
  }

  return { analyze, buildCoachRead, compose };
});
