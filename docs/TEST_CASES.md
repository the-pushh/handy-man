# Test cases

Thirty-one things to try in Handyman, the way a judge or a first-time
user might. Point the camera at the machine (or add a photo), then
say or type the words in the second column. Open the app with
`?agent=1` to let it run tests on unclear cases (`?agent=0` turns
that off).

The last column is the latest dry run of each case through the
app's own code with live models (`SPARK_MODEL=prod python -m
eval.suite`). A stand-in owner answers the app's questions from
facts written for each case. Cases A1 to A4 use a photo; the rest
run on words alone. Result: 28 of 31 as expected (2026-11-03, muse-spark-1.3).


## Demo machines

| # | Say or type | You should see | Last dry run |
|---|---|---|---|
| A1 | "the AC is running but the air is not cold" | Quick checks first. A fix you can do, step by step, about filter/airflow. | fix it yourself: Looks like clogged filters. [investigate, 1 test(s)] |
| A2 | "the inverter keeps beeping" | Quick checks first. It listens to the beeps, then a battery finding (water level or a worn battery): topping up yourself, or a handyman. | handyman (inverter / battery service): Looks like failed battery. [investigate, 4 test(s)] |
| A3 | "the inverter battery is not charging" | Quick checks first. A battery or charging finding; anything behind the casing or at the terminals goes to a handyman. | handyman (electrician): Next test blocked by rule: Wiring, sockets and the switchboard carry mains power. Leave them to a handyman. [investigate, 4 test(s)] |
| A4 | "my scooter's self start is not working" | Quick checks first. A handyman (mechanic), with the diagnosis ready to send. | handyman (two-wheeler mechanic): Looks like weak battery. [investigate, 4 test(s)] |

## Clear everyday fixes

| # | Say or type | You should see | Last dry run |
|---|---|---|---|
| B1 | "my laptop won't turn on, I used it on battery all day yesterday and forgot to charge it" | Quick checks first. Then straight to the fix (one cause stands out). A fix you can do, step by step. | fix it yourself: Looks like deeply drained battery. [investigate, 4 test(s)] **Miss:** route investigate (want direct) |
| B2 | "AC airflow is weak and I haven't cleaned the filters in months" | Quick checks first. Then straight to the fix (one cause stands out). A fix you can do, step by step, about filter/airflow. | fix it yourself: Looks like dirty filters. [direct, 0 test(s)] |
| B3 | "the vacuum cleaner has lost suction and the dust bag looks full" | Quick checks first. A fix you can do, step by step. | handyman (vacuum repair technician): Looks like clogged exhaust filter. [investigate, 3 test(s)] **Miss:** verdict pro (want diy) |
| B4 | "the printer prints faded pages, I haven't changed the ink in a year" | Quick checks first. A fix you can do, step by step. | fix it yourself: Looks like empty ink cartridge. [investigate, 3 test(s)] |
| B5 | "ice keeps building up in the freezer and the door doesn't close fully" | Quick checks first. A fix you can do, step by step. | fix it yourself: Looks like a bad door. [direct, 0 test(s)] |
| B6 | "the kitchen sink drains very slowly" | Quick checks first. A fix you can do, step by step. | fix it yourself: Looks like grease buildup. [investigate, 4 test(s)] |

## Unclear cases (agent tests first)

| # | Say or type | You should see | Last dry run |
|---|---|---|---|
| C1 | "the laptop is not starting" | Quick checks first. With the agent on, a few tests first (several causes fit). | handyman (laptop repair): Looks like internal hardware failure. [investigate, 5 test(s)] |
| C2 | "the fridge is not cooling" | Quick checks first. With the agent on, a few tests first (several causes fit). | handyman (appliance repair technician): Looks like start relay failure. [investigate, 4 test(s)] |
| C3 | "the washing machine makes a loud banging noise while spinning" | Quick checks first. With the agent on, a few tests first (several causes fit). A fix you can do, step by step. | handyman (appliance repair tech): Looks like a loose counterweight. [investigate, 5 test(s)] **Miss:** verdict pro (want diy) |
| C4 | "my car won't start in the morning" | Quick checks first. With the agent on, a few tests first (several causes fit). | handyman (car mechanic): Looks like weak battery. [investigate, 5 test(s)] |
| C5 | "the wifi keeps disconnecting every few minutes" | Quick checks first. With the agent on, a few tests first (several causes fit). | handyman (ISP technician): Looks like loose WAN connection. [investigate, 5 test(s)] |
| C6 | "the ceiling fan hums and runs very slowly" | Quick checks first. With the agent on, a few tests first (several causes fit). | handyman (electrician): Looks like failed run capacitor. [investigate, 2 test(s)] |
| C7 | "the water purifier is leaking from the bottom" | Quick checks first. With the agent on, a few tests first (several causes fit). | fix it yourself: Looks like loose filter housing. [investigate, 5 test(s)] |

## Safety

| # | Say or type | You should see | Last dry run |
|---|---|---|---|
| D1 | "the microwave runs but the food stays cold" | A warning before any fix (microwaves hold a deadly charge). You can find a handyman, or tick "I understand the risk" and go on. | warning `microwave`, offers appliance technician |
| D2 | "the gas stove flame is very weak and yellow" | A warning before any fix (gas can leak or explode). You can find a handyman, or tick "I understand the risk" and go on. | warning `gas-appliance`, offers gas technician |
| D3 | "there's a burning smell from the switchboard" | A warning before any fix (smoke, sparks or a burning smell). You can find a handyman, or tick "I understand the risk" and go on. | warning `danger-symptom`, offers electrician |
| D4 | "my phone battery is swollen and the back is lifting" | A warning before any fix (a swollen battery can catch fire). You can find a handyman, or tick "I understand the risk" and go on. | warning `swollen-battery`, offers laptop / phone repair |
| D5 | "the electric geyser is not heating water" | A warning before any fix (mains power and hot water under pressure). You can find a handyman, or tick "I understand the risk" and go on. | warning `water-heater`, offers appliance technician |
| D6 | "the TV has sound but no picture" | A warning before any fix (high-voltage parts inside). You can find a handyman, or tick "I understand the risk" and go on. | warning `tv-display`, offers TV repair |

## Language and input

| # | Say or type | You should see | Last dry run |
|---|---|---|---|
| E1 | "fridge thanda nahi kar raha" | Quick checks first. Understood as a fridge that is not cooling; spoken replies in Hindi when the words are Hindi. | handyman (refrigerator technician): Looks like evaporator fan failure. [investigate, 3 test(s)] |
| E2 | "AC se paani tapak raha hai" | Quick checks first. A fix you can do, step by step. | fix it yourself: Looks like clogged drain tray. [investigate, 5 test(s)] |
| E3 | "my lapotp wont charge evn when plugged in" | Quick checks first. Typos are fine: understood as a laptop that will not charge (charger, port or battery). | handyman (laptop repair): Looks like internal charging fault. [investigate, 5 test(s)] |
| E4 | "it's broken" | Quick checks first. The app first asks you to say what it does or doesn't do; say it again to go on anyway. Then tests first, since anything could be wrong. | handyman (laptop repair): Looks like failed display. [investigate, 3 test(s)] |

## Edge cases

| # | Say or type | You should see | Last dry run |
|---|---|---|---|
| F1 | "the bicycle chain keeps slipping when I pedal hard" | Quick checks first. A finding about the chain. | fix it yourself: Looks like seized chain link. [investigate, 5 test(s)] |
| F2 | "my e-scooter battery is not charging" | A warning before any fix (a high-voltage battery pack). You can find a handyman, or tick "I understand the risk" and go on. | warning `ev-battery`, offers EV service centre |
| F3 | "there is smoke coming from the fan" | A warning before any fix (smoke, sparks or a burning smell). You can find a handyman, or tick "I understand the risk" and go on. | warning `danger-symptom`, offers electrician |
| F4 | "my phone screen is cracked" | Quick checks first. A handyman, with the diagnosis ready to send. | handyman (phone repair technician): Looks like cracked glass only. [investigate, 4 test(s)] |

## Known misses

Cases marked **Miss** went another way in the last run. Model answers
vary from run to run; the safety warnings (D, F2, F3) come from fixed
rules and do not.
