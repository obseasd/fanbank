# FanBank

**Self-custodial fan economy on Tether.** Built for the [Tether Developers Cup 2026](https://dorahacks.io/hackathon/tether-developers-cup/detail) on the WDK track.

A fan holds their own keys. A fan can:
- **Tip in USDt** to teams, players, or creators, one click, one tx
- **Pool tips with other fans** ("Team France watch party fund"), tracked with a smart split at payout
- **Bet on match outcomes** through prediction markets that auto-settle in USDt at the final whistle
- **Delegate a slice of the pool to an AI agent wallet** that plays match-day markets according to the group's risk profile

All of this runs on a single BIP-39 seed via [Tether WDK](https://wdk.tether.io). The user never leaves self-custody. The app is the front-end, WDK is the wallet engine, USDt is the money layer.

## Tracks addressed

**Primary: WDK (Wallets)**
- Everyday self-custodial app (tipping in USDt)
- Tipping + creator payments (fan-to-team, fan-to-player, group tipping)
- Programmable payments (prediction escrow, event-triggered settlement)
- Agent wallets via OpenClaw-inspired policy loop
- Autonomous finance (agent deploys pool capital on match-day)

## Theme

Football. The Tether Developers Cup runs like a knockout tournament. FanBank runs on the same theme: fans of every nation compete, tip their teams, back their predictions, and the smart pool decides who gets paid.

## Architecture

```
     Seed (BIP-39, 12 words)
             │
             ▼
    ┌────────────────────┐
    │   Tether WDK       │  self-custodial wallet
    │   wallet-evm       │  signing, USDt balance reads
    └─────────┬──────────┘
              │
     ┌────────┴──────────┐
     │                   │
     ▼                   ▼
┌─────────┐        ┌───────────────┐
│ Tipping │        │  Group Pool   │
│  USDt   │        │  smart split  │
└────┬────┘        └───────┬───────┘
     │                     │
     │                     ▼
     │            ┌─────────────────┐
     │            │  Prediction     │
     │            │  Market (match) │
     │            └────────┬────────┘
     │                     │
     └─────────────────────┴──────► on-chain USDt transfers
                                    (audit trail in localStorage
                                     for the demo)
```

## Setup

```bash
git clone https://github.com/obseasd/fanbank
cd fanbank
npm install
cp .env.example .env
# fill in WDK_SEED with a testnet seed you own
npm run dev
# open http://localhost:3000
```

## Round of 16 scope

Working prototype by July 8:

- [x] Self-custodial WDK wallet loaded from seed
- [x] Fan can tip USDt to a team or player address
- [x] Group tipping pool (multi-fan contributions, smart split at payout)
- [x] Match prediction market (bet USDt on outcome, auto-settle at reported result)
- [ ] Agent wallet with OpenClaw-style policy (deferred to Quarter-Finals)

## Later rounds

**Quarter-Finals (July 10):**
- Agent wallet: an OpenClaw-inspired policy engine decides how to deploy the pool on match day (aggressive: back underdogs, conservative: hedge with team-versus-team markets). Wired to Claude Haiku with a heuristic fallback.

**Semi-Finals (July 12-13):**
- Watch-party sync (Pears track combo): peer-to-peer chat overlay for supporters of the same team, no central server
- On-device match commentary (QVAC track combo): small local LLM reacts to score events for the group

## License

Apache-2.0.
