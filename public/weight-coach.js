(function attachLilyWeightCoach(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LilyWeightCoach = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createLilyWeightCoach() {
  "use strict";

  const DAY_MS = 24 * 60 * 60 * 1000;
  const NUMBER_WORDS = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT"];
  const STATE_VERDICTS = Object.freeze({
    "accelerating-loss": "This is excellent progress—the trend is strengthening!",
    "steady-loss": "This is solid progress in the right direction!",
    "turning-loss": "This is an encouraging turn in the right direction!",
    "flat-noisy": "The trend is mixed today, so this is a reset—not a judgment.",
    "turning-gain": "Today moved away from the direction we want, but this is one result.",
    "steady-gain": "The recent trend is moving away from the direction we want.",
    "accelerating-gain": "The upward trend strengthened, so a gentle reset matters now."
  });

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
    const recentGap = changes.length ? changes[changes.length - 1].gap : 0;
    const recentRate = recentGap > 0 ? Math.abs(recentChange / recentGap) : 0;
    const isOutlier = changes.length > 0 && recentRate > 2.5;
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
      recentGap,
      isOutlier,
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
      `OH, THE SCALE WANTS A FIGHT?! +${change} LB TO ${latest}. NOT WHAT WE WANT—LET’S ANSWER!!! ${context} Tighten the next decision and hunt the reversal HARD!!!`,
      `${latest} lb is up ${change} lb since ${dayLabel(read.previousEndDay)}. The ${spokenNumber(read.previousWeighInCount)} weigh-ins before today dropped ${trimWeight(read.previousTotalMovement)} lb, and the 1-year call still points to ${forecast} lb, so the bigger downward push is STILL ALIVE—but today does NOT get a win. Reset one controllable now and make the next weigh-in CLAP BACK HARD!!!`,
      `NEWEST READ: +${change} LB TO ${latest}—MY EYES ARE WIDE OPEN!!! ${context} Pick the reset, own it, and attack the next check—WE’RE COMING BACK!!!`,
      `THAT +${change}-LB RISE JUST TURNED THE VOLUME ALL THE WAY UP!!! ${latest} lb is today’s line. ${context} Bring a fierce, smart reset and go earn the immediate comeback—LET’S GOOOO!!!`
    ][read.seed % 6];
  }

  function flatNoisyCopy(read) {
    const latest = trimWeight(read.latestWeight);
    return [
      `THE SCALE IS THROWING CONFETTI IN EVERY DIRECTION AT ${latest} LB!!! Lily gets to break the tie. Nail one planned choice and make the next weigh-in LOUD—LET’S GOOOO!!!`,
      `${latest} LB AND THE TREND IS IN A FULL TUG-OF-WAR!!! Take control with one strong repeatable choice and make the next number pick our side!!!`,
      `NO BORING LIMBO TODAY—${latest} LB IS THE LAUNCHPAD!!! Plan the next meal or get a walk in, then make the next weigh-in impossible to ignore!!!`,
      `THE TREND HASN’T PICKED A SIDE, SO LILY GETS TO PICK IT!!! ${latest} lb is today’s line. Stack one sharp decision and force some movement—GAME ON!!!`,
      `${latest} LB, HOLDING GROUND—NOW LET’S CREATE SOME MOVEMENT!!! Own one repeatable habit and turn the next weigh-in into a BREAKOUT!!!`,
      `UP, DOWN, SIDEWAYS—THIS SCALE IS BEING DRAMATIC AT ${latest} LB!!! Lily can end the suspense. Win the next decision and make the trend MOVE—LET’S GOOOOOO!!!`
    ][read.seed % 6];
  }

  function firstEntryCopy(read) {
    return `${trimWeight(read.latestWeight)} lb is the starting line. Save the next weigh-in and we’ll make the direction LOUD!!!`;
  }

  function outlierCopy(read) {
    const latest = trimWeight(read.latestWeight);
    const change = trimWeight(Math.abs(read.recentChange));
    return [
      `${latest} lb is ${change} lb away from the previous read—too large a swing to call a real trend yet. Check the entry or confirm it with the next weigh-in, then we’ll call it LOUD!!!`,
      `${latest} lb moved ${change} lb in one jump, so this number needs confirmation before it earns praise or alarm. Verify it and bring the next read!!!`,
      `A ${change}-lb jump to ${latest} lb is too extreme to treat like normal momentum. Check the saved number or stack one confirming weigh-in—THEN WE ATTACK THE REAL STORY!!!`,
      `${latest} lb is a ${change}-lb swing, and one extreme point does not get to write the trend. Confirm the entry and make the next weigh-in settle it!!!`,
      `This ${change}-lb move to ${latest} lb is outside the normal fight. Verify the number or confirm it next time, then we’ll judge the direction HARD!!!`,
      `${latest} lb just landed ${change} lb from the prior read. That needs one confirmation before we celebrate or sound the alarm—CHECK IT AND COME BACK LOUD!!!`
    ][read.seed % 6];
  }

  function legacyVerdict(read) {
    if (!read) return "READY FOR THE FIRST WEIGH-IN!!!";
    if (read.pointCount === 1) return "TOO EARLY TO JUDGE—FIRST NUMBER LOGGED, NOW LET’S BUILD THE TREND!!!";
    if (read.isOutlier) return "THIS NUMBER IS TOO EXTREME TO JUDGE YET—CONFIRM IT!!!";
    return STATE_VERDICTS[read.state] || STATE_VERDICTS["flat-noisy"];
  }

  function verdictTone(read) {
    if (!read || read.pointCount === 1) return "ready";
    if (read.isOutlier || read.state === "flat-noisy") return "neutral";
    if (["accelerating-loss", "steady-loss", "turning-loss"].includes(read.state)) return "positive";
    return "negative";
  }

  function legacyComposeDetail(read) {
    if (!read) return "DROP IN A WEIGH-IN AND LET’S LIGHT THIS TRACKER UP!!!";
    if (read.pointCount === 1) return firstEntryCopy(read);
    if (read.isOutlier) return outlierCopy(read);
    if (read.state === "accelerating-loss") return acceleratingLossCopy(read);
    if (read.state === "steady-loss") return steadyLossCopy(read);
    if (read.state === "turning-loss") return turningLossCopy(read);
    if (read.state === "accelerating-gain") return gainCopy(read, true);
    if (read.state === "steady-gain") return gainCopy(read, false);
    if (read.state === "turning-gain") return turningGainCopy(read);
    return flatNoisyCopy(read);
  }

  function legacyCompose(read) {
    return `${legacyVerdict(read)} ${legacyComposeDetail(read)}`;
  }

  function supportiveAction(read) {
    if (read.isOutlier) return "Repeat the next weigh-in under the same scale conditions.";
    if (read.state === "flat-noisy") return "Choose one satisfying planned snack before you need it.";
    if (["accelerating-loss", "steady-loss", "turning-loss"].includes(read.state)) {
      return read.seed % 2
        ? "Take one comfortable walk after the next meal."
        : "Build the next meal around protein, vegetables, and a satisfying portion.";
    }
    return read.seed % 2
      ? "Make the next meal a simple mix of protein, vegetables, and a satisfying portion."
      : "Have a full glass of water alongside the next satisfying meal.";
  }

  function supportiveDetail(read) {
    const latest = trimWeight(read.latestWeight);
    if (read.pointCount === 1) {
      return `${latest} lb is the starting point, with no earlier movement to judge. Save the next weigh-in under the same scale conditions. This first number is information, not identity, and the rest of the trend is still unwritten.`;
    }
    if (read.isOutlier) {
      const change = trimWeight(Math.abs(read.recentChange));
      return `${latest} lb is ${change} lb from the previous reading, which is too unusual to call a trend yet. ${supportiveAction(read)} One extreme point cannot define your progress; a fair follow-up will make the direction clearer.`;
    }
    const movement = trimWeight(read.totalMovement);
    const action = supportiveAction(read);
    const positive = ["accelerating-loss", "steady-loss", "turning-loss"].includes(read.state);
    const flat = read.state === "flat-noisy";
    const evidence = flat
      ? `${latest} lb keeps the recent direction mixed rather than settled`
      : positive
        ? `${latest} lb puts the current run ${movement} lb lower`
        : `${latest} lb puts the current run ${movement} lb higher`;
    const closings = positive ? [
      "This progress is real—let yourself enjoy it!",
      "The better direction is showing up clearly!",
      "This is encouraging evidence, and it is yours!",
      "A better trend is taking shape right here!",
      "The line moved your way, and that matters!",
      "This move counts, and the momentum is alive!"
    ] : flat ? [
      "Mixed data is not rejection; the story is still open.",
      "This is information, not identity, and the direction can still change.",
      "Nothing is settled yet; one doable step is enough for today.",
      "The line is undecided, not hopeless, and there is room to move.",
      "Today is one chapter, and the next point can clarify it.",
      "You are not stuck; the trend simply needs more context."
    ] : [
      "One result does not define you; the next step can still help!",
      "You are not starting over; there is room to turn this!",
      "This is data, not a judgment; the path forward is open!",
      "The line can turn without solving everything at once!",
      "Today is one chapter, and the story can still improve!",
      "Better direction is possible from exactly where you are!"
    ];
    return `${evidence}. ${action} ${closings[read.seed % closings.length]}`;
  }

  function verdict(read) {
    if (!read) return "The coach is ready for the first weigh-in.";
    if (read.pointCount === 1) return "The baseline is set, with no judgment on day one.";
    if (read.isOutlier) return "This reading needs confirmation before judgment.";
    return STATE_VERDICTS[read.state] || STATE_VERDICTS["flat-noisy"];
  }

  function composeDetail(read) {
    if (!read) return "Save one honest weigh-in when you are ready. The first number is only a starting point, and the direction remains open.";
    return supportiveDetail(read);
  }

  function compose(read) {
    return `${verdict(read)} ${composeDetail(read)}`;
  }

  function buildCoachRead(points, forecast) {
    return compose(analyze(points, forecast));
  }

  return { STATE_VERDICTS, analyze, buildCoachRead, compose, composeDetail, verdict, verdictTone };
});
