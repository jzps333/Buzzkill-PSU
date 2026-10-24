"""Everything the Pi says out loud. {name} gets swapped for the player's name."""

import random

PICKUP = [
    "{name} picked up their phone. Bold move during a study session.",
    "Attention everyone. {name} could not last. Phone is in hand.",
    "{name}, put it down. The group chat can wait.",
    "Breaking news: {name} has chosen scrolling over studying.",
    "{name} just picked up their phone. Everyone, make eye contact with {name}.",
    "{name}! I saw that. Everyone saw that.",
    "Wow {name}. Your grades called. They want a word.",
    "{name} has abandoned the squad for their phone.",
]

REPEAT = [
    "{name}, still on the phone? Shake it to make me stop.",
    "{name}. {name}. {name}. Shake the phone.",
    "I will keep going, {name}. Shake. The. Phone.",
    "{name} is still losing points right now. Shake it, {name}.",
    "Everyone, {name} is still on their phone. Point and laugh.",
]

NAG = [
    "{name} has been on the phone way too long. Back to work.",
    "Hey {name}, that phone is not going to study for you.",
    "{name} quietly wandered off into their phone again. Busted.",
]

SURRENDER = [
    "{name} shook it off. Shame recorded.",
    "Fine, {name}. But I will remember this.",
    "{name} begged for mercy. Mercy granted. Points not.",
    "Okay {name}. Back to work.",
]

LEAD = [
    "{name} takes the lead!",
    "New leader: {name}. Everyone else, step it up.",
    "{name} is now in first place. Bragging rights loading.",
]

START = (
    "Buzzkill is live with {count} players. Phones face down. "
    "Pick one up and I will tell everyone. Good luck."
)

WIN = "Time! {name} wins with {score} points. Bragging rights officially granted."

LOSER = [
    "And in last place, {name}, with {pickups} pickups. Your textbook filed a missing person report.",
    "Last place goes to {name}. {pickups} pickups. Your phone is proud of you. Nobody else is.",
    "{name} finishes last with {pickups} pickups. Maybe try studying next time.",
]

PERFECT = "And {name} never touched their phone once. Absolute legend."


def line(options, **kw):
    if isinstance(options, str):
        return options.format(**kw)
    return random.choice(options).format(**kw)
