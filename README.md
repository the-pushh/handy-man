# Handyman

**Try DIY before you call a handyman.**

Open **https://handyman.thepushh.com** on your phone. It's free, with no
sign-up and nothing to install.

Point your camera at something that's acting up and say what's wrong.
Handyman finds the machine, runs the quick checks people often miss,
walks you through a safe fix step by step, and checks your work with the
camera. If it's a job for a professional, it finds a handyman near you
and writes the message for you.

## How to use it

1. **Open the link and allow the camera and microphone.** It works best
   on a phone held upright. Android Chrome and iPhone Safari both work.
2. **Tap to speak** and say what's wrong: the machine, and what it does
   or doesn't do. For example, "the AC runs but the air isn't cold".
   - **Can't talk?** Tap **Type**.
   - **Camera not working?** Tap **Photo**, then describe the problem.
3. **Point the camera at the machine.**
   - Handyman outlines it on the screen and tells you if you need to
     move closer or back.
   - When the view is right, it takes the picture itself.
   - If it can't find the machine, tap **Use this view**.
4. **Try the quick checks.** These are the simple things people often
   miss, like a switch, a setting or a loose plug. Tap **That fixed it**
   or **Still not working**.
5. **Answer a few questions** if Handyman isn't sure yet. When several
   causes fit, it shows a board of possible causes and asks one quick
   question or for one photo at a time until one cause stands out.
6. **Follow the steps.** Each step is read out loud, and the part to
   look at is highlighted on the photo.
   - **Scan to check this step** takes a quick photo and tells you if
     the step is done.
   - **New view:** after a step that changes how the machine looks
     (like lifting a panel), Handyman asks for a new picture so it can
     point at the next part.
   - **Already fixed?** Between steps it asks "Is it working now?". If
     it is, you can stop there.
7. **Check the result.** Handyman takes an "after" photo and asks
   whether it's working. If it's still broken, tell it what's wrong and
   it tries once more.
8. **Call a handyman when needed.** For risky jobs, or when the fix
   doesn't work, Handyman lists people near you: open now, closest and
   best rated first.
   - **Call**, **WhatsApp**, **Text** or **Map** for each one.
   - The WhatsApp and text message come with the diagnosis already
     written. You just press send.
9. **Look back in History.** Every fix is saved with its photos, steps,
   outcome and the handymen you found.

## Tips

- **Be specific.** "It's broken" or "not working" doesn't say what's
  wrong. "Won't turn on, charger light is off" does.
- **Light it up.** In a dark spot, tap the torch button in the corner of
  the camera (on phones that allow it, such as Android Chrome). It
  pulses when the picture is too dark.
- **Hold steady and keep one machine in view.**
- **Turn the volume up.** Handyman talks you through each step.

## Safety

Handyman gives advice only.

- **Before you start:** unplug before you touch anything.
- **Stop at once if you see:** smoke, sparks, a swollen battery, or a
  smell of gas.
- **Risky machines get a warning first,** before anything else. These
  include microwaves, gas stoves, geysers, switchboards, EV batteries and
  TVs. You can call a handyman, or tick "I understand the risk" and go on
  at your own risk.
- **Unsafe steps are never suggested,** such as wiring, gas fittings,
  battery terminals or sealed casings. Handyman sends you to a handyman
  instead.

## Your data

- **No login.** Your history is saved for this browser, on your phone
  and on our server.
- **Learning:** how fixes turn out (words only, never photos, sound or
  location) helps Handyman learn which causes are common. Turn this off
  in History.
- **Delete my history** in History removes everything, from your phone
  and from our server.
- **Location** is used only to find handymen near you, and is never
  stored.

## Languages

Speak or type in English or Hinglish ("fridge thanda nahi kar raha"). Replies are spoken in English, or in Hindi
for Hindi text.

## Things to try

[docs/TEST_CASES.md](docs/TEST_CASES.md) lists 31 things to say, from an
AC that isn't cooling to a phone with a swollen battery, with what you
should see for each.

## For developers

```
make            # backend on :8000 and frontend on :3000
```

Open http://127.0.0.1:3000.

- **Keys:** needs `MUSE_SPARK_API_URL` and `MUSE_SPARK_API_KEY` in `.env`
  at the repo root. Every variable is documented in
  `backend/.env.example` and `frontend/.env.example`.
- **How it works:** the flow, which Meta model runs where, the safety
  rules, tests and evals, and deployment are in
  [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md).
- **Built during the Meta hackathon** (Oct 26 to Nov 4, 2026). Every
  model call is live, with no canned answers.
- **What comes next:** [FUTURE.md](FUTURE.md).
