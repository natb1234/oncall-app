# OnCall — App Store checklist

Checked 28 Oct 2026 against two "how not to get rejected" videos and Apple's App Review Guidelines.

## Done in the app
| Apple requirement | Status |
|---|---|
| Privacy Policy URL (5.1.1) | ✅ https://natb1234.github.io/oncall-app/privacy.html |
| Terms of Use URL | ✅ https://natb1234.github.io/oncall-app/terms.html |
| Support URL | ✅ https://natb1234.github.io/oncall-app/support.html (fill in the contact email) |
| Delete account inside the app (5.1.1(v)) | ✅ Profile → Account → Delete my account |
| Report content (1.2) | ✅ ⚑ Report on jobs and message threads |
| Block users (1.2) | ✅ ⊘ Block on jobs and message threads; Profile → Blocked people to unblock |
| Contact info in the app (1.2) | ✅ Profile → Help & support |
| Age gate | ✅ 18+ ID check before posting or bidding |
| Sign in with Apple (4.8) | Not needed — OnCall only has email + password login. Required only if Google/Facebook login is added. |
| AI consent screen | Not needed — OnCall uses no AI. |

## Payments (guideline 3.1)
- **Job payments** (poster pays worker for a real-world job) are physical services → Stripe is allowed (3.1.5(a)). No change.
- **Premium (€4.99/month) and Boost (€1.99)** are digital extras used inside the app → Apple requires its own in-app purchase (Apple takes 15% under the Small Business Program).
  For now the iPhone app **hides** the Premium "Go Premium" button and Boost (see `IN_IOS_APP` in index.html). Existing subscribers can still cancel.
  Later: add Apple in-app purchase (e.g. RevenueCat or Adapty) if you want to sell Premium/Boost in the iPhone app.

## Still to do (you)
1. **Apple Developer Program** — €99/year, developer.apple.com. As a sole trader you enrol as an individual; your own name shows on the App Store. With a Ltd you'd need a D-U-N-S number.
2. **Fill `[contact email]`** in support.html, privacy.html, terms.html (needs the domain).
3. **Build the iPhone app.** OnCall is a website today. It needs a native wrapper (Capacitor is the usual choice). There's no Mac needed if you use a cloud build service (Codemagic, Ionic Appflow). Apple rejects apps that are "just a website" (4.2), so the wrapper should add something native — push notifications for new bids/messages is the obvious one.
   The wrapper must add `OnCallApp` to the browser user agent (Capacitor: `appendUserAgent: "OnCallApp"`) so the app knows to hide Premium/Boost.
   Stripe Checkout, Stripe Connect and Stripe Identity return to `natb1234.github.io` — they'll need to open in the in-app browser and come back via a universal link. Plan this before building.
4. **Camera permission text** (Info.plist), because job photos and ID checks use the camera:
   - `NSCameraUsageDescription`: "OnCall uses your camera to take photos of jobs and of finished work, and to photograph your ID for the 18+ check."
   - `NSPhotoLibraryUsageDescription`: "OnCall lets you choose photos of jobs and finished work from your library."
   - `NSLocationWhenInUseUsageDescription`: "OnCall uses your location to find jobs near you. Only the area (about 1 km) is saved."
   - `NSMicrophoneUsageDescription` (job videos record sound): "OnCall records sound when you film a short video of a job."
5. **App Store Connect listing:**
   - Disclose paid features in the description (and in App Privacy answers): job payments with a 10% fee (6% for Premium), Premium €4.99/month, Boost €1.99 — or say "not available in the iPhone app" while they're hidden.
   - **Review notes**: give Apple a working demo login that is already ID-verified (Apple can't pass a real ID check), and say payments are in Stripe test mode, or switch to live first.
   - Age rating questionnaire: user-generated content + messaging → answer honestly (likely 17+/18+ given the 18+ rule).
   - App Privacy "nutrition label": email, name, approximate location, photos, payment info (via Stripe), ID check (via Stripe), messages.
