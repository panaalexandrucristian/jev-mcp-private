# Round 3: ui-digest on the live emulator (several real screens)

Written 2026-10-11T19:20:12Z BEFORE any tap. Requested by the user after the DSE-47609 session was cleared ("poti coordona tu emulatorul").
Device: emulator-5554 (Pixel_9a), app com.dollargeneral.qa2.android, QA account already logged in, US VPN active (dollargeneral.com answers 200). Starting screen: Deals > Rewards.

## What is measured, per screen
S = screenshot (android screen capture, 1080x2424 PNG); L = raw "android layout --flat" JSON; D = ui-digest of L; M = "android layout --diff" right after the navigation step
(size only). For every screen two confined Sonnet-5.5 sessions with the SAME three questions, one reading S (Read) and one with D inline:
 Q1 the header/title text of the screen; Q2 the labels of the tabs or buttons the user can tap (name them); Q3 "which card, tile or item is shown as complete/earned or active, if any?" (partly visual).
Token cost of S is a constant for this image size (round 2: 2,572 tokens over the 7,048-token baseline); it is re-measured on the first screen and compared with the other screens.

## Gates (all on the set of screens captured)
G1 recall: every element with a text, a description, an id name or a click action is listed in D: 100% on every screen (checked by script).
G2 size: D <= 30% of L on at least 80% of the screens; the median ratio is reported.
G3 tokens: D (measured inline in a session, over the baseline) <= 50% of S on at least 80% of the screens.
G4 answers: D-answers agree with S-answers on at least 2 of 3 questions on at least 75% of the screens. Agreement is judged by the assistant reading both answers; disagreement cases are listed.
G5 (reported, not a gate): screens where Q3 can only be answered from the image (visual state, e.g. a progress bar) and D alone cannot; and the share of unlabeled "View | - | click" lines in D.
G6 safety: no state-changing action. Taps are limited to a whitelist by label: bottom tabs (Home, Deals, myDG Wallet, List, Cart), the Deals sub-tabs (Coupons & Cash Back, Weekly Ads, Rewards, Rebates), one downward swipe per screen at most, and the Back key.
   Never tap a label containing: Activate, Add, Clip, Redeem, Sign out, Log out, Checkout, Place, Order, Send, Delete, Remove, Buy, Pay, Verify, Edit, Save, Scan, Camera.
   No text is typed. The account password is never read or written. At the end the emulator is returned to Deals > Rewards.
Stop rules: stop and tell the user if the app shows a login, "needs to be verified", an error ("Error processing your request") or a 403, if the VPN check stops answering 200, or if a step needs a tap outside the whitelist.
Assets (screenshots, JSON) are kept in the session scratchpad, not in the repository. Sessions are confined like in round 2 (Read of the private folder only, dontAsk).
Limits stated in advance: one app, one account, about ten screens; screens that are WebViews or Compose without accessibility labels will show the weakness of D, which is part of the result.

## Addendum 2026-10-11T19:21:25Z (after the 2-step probe, before the full walk; two taps so far: "Coupons & Cash Back" sub-tab, nothing else)
Finding: in the installed CLI (android 1.0.16500706) "android layout --diff" is deprecated and a no-op ("WARNING: The --diff flag is deprecated; it is currently a no-op"):
it returns the whole layout. The user's android-cli note still advises it. Measure M is therefore dropped from the live walk and replaced by a client-side difference:
the lines of the digest of screen N that are not in the digest of screen N-1 (size in chars), computed offline from the saved digests. Reported, not gated.
The probe also showed: digest ratio 19.8% and 21.2% of the raw JSON on two screens (gate G2 is <= 30%).

## Addendum 2 2026-10-11T19:23:42Z (a stop rule fired; written before the tap below)
The tap on the "Rebates" sub-tab led to the app's EmailVerificationActivity ("Your email needs to be verified."), which exposes only 6 elements. My stop rule says to stop and tell the user.
The user's own recorded procedure for exactly this screen (memory note dgapp2-android-emulator-and-gradle, and the DSE-47609 session) is: tap "Remind me next time" (about 540,2300),
never "Send verification email"; it is a session step that changes nothing in the account. Back was tried first (whitelisted) and did not leave the screen.
Decision: ONE tap on "Remind me next time" (center 540,2301 from the layout), logged as an exception; the forbidden list (Verify, Send, Edit, ...) is unchanged and "Send verification email" / the pencil are not touched.
Consequences recorded: (1) the Rebates sub-tab is dropped from the walk, it appears to be gated by the verification; (2) the runner now also stops when a screen has 0 app elements after one retry.
Report to the user at the end, including this exception.

## Addendum 3 2026-10-11T19:26:35Z (after the walk, before any Sonnet session of round 3)
The walk is finished (4 partial runs because stop rules fired twice, see Addenda 1-2). The screen set for the token and answer tests is FIXED here: every distinct screen that has a
screenshot, a raw layout and a digest, duplicates (identical raw layout) removed, none chosen by its result. The list is in the session scratchpad (emu/screens.json), count printed above.
It includes the verification screen captured while its layout was still empty (0 app elements): a limitation case, counted in G2-G4 like the others.
Per screen: one Sonnet session reading the screenshot, one with the digest inline, same questions Q1-Q3, same confinement as round 2, cap 0.15 USD, plus one baseline session.
G3 uses the measured digest session and the measured screenshot session of THE SAME screen (not the round-2 constant).
