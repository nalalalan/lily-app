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

    let previousDirection = 0;
    let previousTransitionCount = 0;
    let previousStart = changes.length >= 2 ? changes[changes.length - 2].newer : null;
    const previousEnd = previousStart;
    for (let index = changes.length - 2; index >= 0; index -= 1) {
      const row = changes[index];
      if (row.gap < 1 || row.gap > 2 || Math.abs(row.change / row.gap) < 0.1 || Math.abs(row.change / row.gap) > 2.5) break;
      const rowDirection = Math.sign(row.change);
      if (!previousDirection) previousDirection = rowDirection;
      if (rowDirection !== previousDirection) break;
      previousTransitionCount += 1;
      previousStart = row.older;
    }
    const previousTotalChange = previousStart && previousEnd
      ? previousEnd.weight - previousStart.weight
      : 0;
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
      previousDirection,
      previousTransitionCount,
      previousWeighInCount: previousTransitionCount ? previousTransitionCount + 1 : 0,
      previousStartDay: previousStart ? previousStart.day : null,
      previousEndDay: previousEnd ? previousEnd.day : null,
      previousStartWeight: previousStart ? previousStart.weight : null,
      previousEndWeight: previousEnd ? previousEnd.weight : null,
      previousTotalChange,
      previousTotalMovement: Math.abs(previousTotalChange),
      oneYearWeight: Number(forecast && forecast.oneYearWeight)
    };
  }

  function priorLossContext(read) {
    if (read.previousDirection >= 0 || read.previousTransitionCount < 2) {
      return "This number gets a full-energy answer RIGHT NOW!!!";
    }
    const count = spokenNumber(read.previousWeighInCount);
    const movement = trimWeight(read.previousTotalMovement);
    const facts = `${trimWeight(read.previousStartWeight)} → ${trimWeight(read.previousEndWeight)} lb`;
    return [
      `The ${count} weigh-ins before today cut ${movement} lb, so we already know this scale can move our way!!!`,
      `Today interrupted a ${movement}-lb, ${count}-weigh-in slide—the progress proof is STILL RIGHT THERE!!!`,
      `That follows ${count} weigh-ins moving ${facts}, so the comeback blueprint is fresh!!!`,
      `The run immediately before this was ${count} lower weigh-ins and ${movement} lb down—we know exactly what a response looks like!!!`,
      `One rise just challenged a ${count}-weigh-in drop; it did NOT erase it!!!`,
      `Lily had ${movement} lb of downward momentum before this jump, and we are calling it back NOW!!!`
    ][read.seed % 6];
  }

  function priorGainContext(read) {
    if (read.previousDirection <= 0 || read.previousTransitionCount < 2) {
      return "The comeback door is OPEN—charge through it!!!";
    }
    const count = spokenNumber(read.previousWeighInCount);
    const movement = trimWeight(read.previousTotalMovement);
    return [
      `That just punched back after ${count} higher weigh-ins and ${movement} lb of climb!!!`,
      `A ${movement}-lb upward run finally cracked—NOW PRESS THE TURN!!!`,
      `The previous ${count} weigh-ins climbed, and this drop just changed the fight!!!`,
      `This snapped a ${count}-weigh-in rise—THE COMEBACK IS LIVE!!!`,
      `After ${movement} lb up, Lily just forced the first move back down!!!`,
      `The wrong-way run finally took a hit—NOW MAKE IT TWO!!!`
    ][read.seed % 6];
  }

  function acceleratingLossCopy(read) {
    const count = numberWord(read.weighInCount);
    const start = trimWeight(read.startWeight);
    const latest = trimWeight(read.latestWeight);
    const days = read.durationDays === 1 ? "one day" : `${spokenNumber(read.durationDays)} days`;
    const forecast = trimWeight(read.oneYearWeight);
    const growing = read.movementGrowing ? ", and every drop got bigger" : "";
    return [
      `${numberWord(read.transitionCount)} DROPS IN A ROW—${start} → ${latest} lb in ${days}!!! The scale is moving with PURPOSE now. Protect this streak and hunt the next lower number—WEOOOOOOOOO!!!`,
      `${count} LOWER WEIGH-INS IN A ROW—${start} → ${latest} lb in ${days}${growing}!!! THIS IS A FULL-BLAST RUN. Lock in the routine and make weigh-in ${spokenNumber(read.weighInCount + 1)} another win—LET’S GOOOOOO!!!`,
      `LILY IS FLYING!!! ${start} → ${latest} lb since ${dayLabel(read.startDay)}, with ${read.transitionCount} straight drops, and the 1-year call just charged to ${forecast} lb. ARE YOU KIDDING ME?! KEEP PRESSING!!!`,
      `THIS RUN IS ABSOLUTELY AWESOME!!! ${latest} lb now, ${trimWeight(read.totalMovement)} lb down across ${read.weighInCount} weigh-ins, and the newest drop was ${trimWeight(Math.abs(read.recentChange))} lb. The momentum is getting LOUDER—GO STACK ANOTHER ONE!!!`,
      `OH, THIS IS REAL PROGRESS!!! ${latest} lb now, ${count} lower weigh-ins, ${trimWeight(read.totalMovement)} lb gone in ${days}, and the forecast is answering hard. Repeat the winning basics—WE ARE COOKING!!!`,
      `THE SCALE BROKE OUR WAY AND LILY KEPT PUSHING!!! ${start} → ${latest} lb with ${read.transitionCount} drops and no bounce. Chase weigh-in ${read.weighInCount + 1}—WE’RE ROLLING, GO GO GO!!!`
    ][read.seed % 6];
  }

  function steadyLossCopy(read) {
    const facts = `${trimWeight(read.startWeight)} → ${trimWeight(read.latestWeight)} lb`;
    return [
      `YESSSSS!!! ${numberWord(read.transitionCount)} STRAIGHT DROPS—${facts}, ${trimWeight(read.totalMovement)} lb DOWN. The line is clean and the work is landing. Hold the rhythm and collect another lower number!!!`,
      `${trimWeight(read.latestWeight)} LB AND ${trimWeight(read.totalMovement)} LB DOWN SINCE ${dayLabel(read.startDay).toUpperCase()}—LET’S GOOOO!!! The direction is ours. Stay locked in and drive it lower again!!!`,
      `DOWN AGAIN!!! The scale keeps stepping ${facts}. THIS IS THE STUFF. Bring one more focused day and make this streak impossible to ignore!!!`,
      `MOMENTUM IS ALIVE!!! ${trimWeight(read.latestWeight)} lb now after ${read.weighInCount} lower weigh-ins and ${trimWeight(read.totalMovement)} lb gone. Go earn the next drop—LET’S GOOOOOO!!!`,
      `LILY IS STACKING WINS!!! ${facts} across ${read.weighInCount} lower weigh-ins. Keep the routine tight and send that line down again!!!`,
      `ANOTHER LOWER NUMBER—BOOM!!! ${trimWeight(read.latestWeight)} lb now and ${trimWeight(read.totalMovement)} lb down for this run. PRESS THE ADVANTAGE AND KEEP IT COMING!!!`
    ][read.seed % 6];
  }

  function turningLossCopy(read) {
    const context = priorGainContext(read);
    return [
      `YESSSSS—${trimWeight(read.latestWeight)} LB AFTER A ${trimWeight(Math.abs(read.recentChange))}-LB DROP!!! ${context} Bring the heat and turn one drop into two—LET’S GO!!!`,
      `THE SCALE JUST FLIPPED OUR WAY!!! ${trimWeight(read.latestWeight)} lb, down ${trimWeight(Math.abs(read.recentChange))}. ${context} Charge through the opening and stack the next lower weigh-in!!!`,
      `DOWN ${trimWeight(Math.abs(read.recentChange))} LB TO ${trimWeight(read.latestWeight)}—NOW WE’RE TALKING!!! ${context} Stay locked in and make this the opening move of a real run!!!`,
      `COMEBACK MODE IS ON!!! ${trimWeight(read.latestWeight)} lb after a ${trimWeight(Math.abs(read.recentChange))}-lb drop. ${context} Go make the next number lower and turn this momentum into a ROAR!!!`,
      `LILY ANSWERED BACK—${trimWeight(read.latestWeight)} LB, DOWN ${trimWeight(Math.abs(read.recentChange))}!!! ${context} Keep pressing and force the next weigh-in to confirm the turn!!!`,
      `THERE IT IS: ${trimWeight(Math.abs(read.recentChange))} LB DOWN TO ${trimWeight(read.latestWeight)}!!! ${context} Grab this opening and make the next number even better—LET’S GOOOOOO!!!`
    ][read.seed % 6];
  }

  function gainCopy(read, accelerating) {
    const count = numberWord(read.weighInCount);
    const facts = `${trimWeight(read.startWeight)} → ${trimWeight(read.latestWeight)} lb`;
    const speed = accelerating && read.movementGrowing ? " and the jumps are getting larger" : "";
    return [
      `WAKE-UP CALL!!! ${count} HIGHER WEIGH-INS—${facts}${speed}. This run stops here. Plan the next meal or get a walk in, then fight for the turn—LOCK IN!!!`,
      `${trimWeight(read.latestWeight)} LB, UP ${trimWeight(read.totalMovement)} SINCE ${dayLabel(read.startDay).toUpperCase()}—THE TREND IS PUSHING BACK HARD!!! Answer with one planned choice and attack the next weigh-in—LET’S FLIP IT!!!`,
      `${facts} across ${read.weighInCount} weigh-ins—WE ARE MOVING THE WRONG WAY AND IT NEEDS AN ANSWER!!! Reset one controllable now and go earn the pivot!!!`,
      `THE SCALE IS CLIMBING, SO WE ARE CLAPPING BACK!!! ${count} higher reads, +${trimWeight(read.totalMovement)} lb to ${trimWeight(read.latestWeight)}${speed}. Tighten the next decision and BREAK THIS STREAK!!!`,
      `TREND ALARM—LET’S MOVE!!! ${facts} in ${read.durationDays} days. Plan the next meal or get a walk in, then hunt the reversal HARD!!!`,
      `UPWARD STREAK CONFIRMED—TIME TO FIGHT FOR THE TURN!!! ${trimWeight(read.latestWeight)} lb after ${trimWeight(read.totalMovement)} lb across ${read.weighInCount} weigh-ins. Choose the reset and make the next check the pivot!!!`
    ][read.seed % 6];
  }

  function turningGainCopy(read) {
    const context = priorLossContext(read);
    const latest = trimWeight(read.latestWeight);
    const change = trimWeight(read.recentChange);
    const forecast = trimWeight(read.oneYearWeight);
    return [
      `ALRIGHT LILY—UP ${change} LB TO ${latest}, SO THE COMEBACK STARTS RIGHT NOW!!! ${context} Plan the next meal or get a walk in, then hunt the bounce-back—LET’S GOOOOOO!!!`,
      `${latest} LB TODAY—UP ${change}, AND THE COMEBACK MISSION IS LIVE!!! ${context} The 1-year call is ${forecast} lb. Make one strong reset and attack the next weigh-in!!!`,
      `OH, THE SCALE WANTS A FIGHT?! +${change} LB TO ${latest}. GOOD—LET’S ANSWER!!! ${context} Tighten the next decision and hunt the reversal HARD!!!`,
      `${latest} LB—UP ${change} SINCE ${dayLabel(read.previousEndDay).toUpperCase()}, AND THE 1-YEAR CALL IS NOW ${forecast} LB!!! ${context} Plan the next meal or get a walk in, then make the next weigh-in CLAP BACK—COME ONNNNN!!!`,
      `NEWEST READ: +${change} LB TO ${latest}—MY EYES ARE WIDE OPEN!!! ${context} Pick the reset, own it, and attack the next check—WE’RE COMING BACK!!!`,
      `THAT +${change}-LB RISE JUST TURNED THE VOLUME ALL THE WAY UP!!! ${latest} lb is today’s line. ${context} Bring a fierce, smart reset and go earn the immediate comeback—LET’S GOOOO!!!`
    ][read.seed % 6];
  }

  function flatNoisyCopy(read) {
    const latest = trimWeight(read.latestWeight);
    return [
      `THE SCALE IS THROWING CONFETTI IN EVERY DIRECTION AT ${latest} LB!!! Perfect—Lily gets to break the tie. Nail one planned choice and make the next weigh-in LOUD—LET’S GOOOO!!!`,
      `${latest} LB AND THE TREND IS IN A FULL TUG-OF-WAR!!! Take control with one strong repeatable choice and make the next number pick our side!!!`,
      `NO BORING LIMBO TODAY—${latest} LB IS THE LAUNCHPAD!!! Plan the next meal or get a walk in, then make the next weigh-in impossible to ignore!!!`,
      `THE TREND HASN’T PICKED A SIDE, SO LILY GETS TO PICK IT!!! ${latest} lb is today’s line. Stack one sharp decision and force some movement—GAME ON!!!`,
      `${latest} LB, HOLDING GROUND—NOW LET’S CREATE SOME MOVEMENT!!! Own one repeatable habit and turn the next weigh-in into a BREAKOUT!!!`,
      `UP, DOWN, SIDEWAYS—THIS SCALE IS BEING DRAMATIC AT ${latest} LB!!! Lily can end the suspense. Win the next decision and make the trend MOVE—LET’S GOOOOOO!!!`
    ][read.seed % 6];
  }

  function compose(read) {
    if (!read) return "DROP IN A WEIGH-IN AND LET’S LIGHT THIS TRACKER UP!!!";
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
