# proteus

This program will roll your pending Proteus rewards (ie, SUSHI & gOHM) back
into the liquidity pool and stake them to continue getting more Proteus rewards.

It only works for Arbitrum!

It's just like what you'd do manually, but with less clicking.

Install the script:

```
npm install -g
```

Configure your wallet! Copy the `wallet.template` file to `~/.wallet` and
enter the JSON RPC endpoint for your Arbitrum node along with your wallet's
private key.

**NOTE! This is dangerous and you should only do it if you trust your computer.**

(You should also only do it if you have read this code and trust that it's
not doing anything nefarious. I am not stealing your keys but you would
certainly be well served to verify that.)

You can check your balance to see if rolling will be worth it:

```
$ proteus balance
```

When you roll, it harvests your pending rewards, sells all the SUSHI for ETH,
sells half the gOHM for ETH, deposits the remaining gOHM and the necessary
amount of ETH into the LP, and deposits it into Sushi Minichef.

```
$ proteus roll
```

Saves me a bit of time. Maybe you too.
