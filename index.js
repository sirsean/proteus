#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import Big from 'big.js';
import { ethers } from 'ethers';
import ERC20 from './abi/ERC20.js';
import MiniChefV2 from './abi/MiniChefV2.js';
import UniswapV2Pair from './abi/UniswapV2Pair.js';
import UniswapV2Router02 from './abi/UniswapV2Router02.js';
import UniswapV2Factory from './abi/UniswapV2Factory.js';
import OhmRewarder from './abi/OhmRewarder.js';

const configPath = path.join(os.homedir(), '.wallet');
if (!fs.existsSync(configPath)) {
    console.log('config file missing, please place it at:', configPath);
    process.exit();
}
const config = JSON.parse(fs.readFileSync(configPath));
const arbitrum = new ethers.providers.JsonRpcProvider(config.arbitrum);
const signer = (new ethers.Wallet(config.key)).connect(arbitrum);

const SUSHI = '0xd4d42F0b6DEF4CE0383636770eF773390d85c61A';
const gOHM = '0x8D9bA570D6cb60C7e3e0F31343Efe75AB8E65FB1';
const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const erc20Addresses = [
    SUSHI,
    gOHM,
];
const sushiswapRouter = '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506';
const miniChefAddress = '0xF4d73326C13a4Fc5FD7A064217e12780e9Bd62c3';

function calculateDeadline() {
    return parseInt((new Date()).getTime()/1000) + 100;
}

await signer.getAddress().then(console.log);

async function erc20Info(contractAddr) {
    const contract = new ethers.Contract(contractAddr, ERC20, arbitrum);
    return Promise.all([
        contract.symbol(),
        contract.decimals(),
    ]).then(([symbol, decimals]) => {
        return { contractAddr, symbol, decimals };
    });
}

async function erc20Balance(contractAddr, addr) {
    const contract = new ethers.Contract(contractAddr, ERC20, arbitrum);
    return Promise.all([
        erc20Info(contractAddr),
        contract.balanceOf(addr),
    ]).then(([info, balance]) => {
        return {...info, balance};
    });
}

async function allErc20Balances(addr) {
    return Promise.all(erc20Addresses.map(contractAddr => {
        return erc20Balance(contractAddr, addr);
    }));
}

async function uniswapPairInfo(contractAddr) {
    const contract = new ethers.Contract(contractAddr, UniswapV2Pair, arbitrum);
    return Promise.all([
        contract.totalSupply(),
        contract.token0().then(erc20Info),
        contract.token1().then(erc20Info),
        contract.getReserves(),
    ]).then(([totalSupply, token0, token1, reserves]) => {
        return {
            totalSupply,
            token0: {...token0, amount: reserves[0]},
            token1: {...token1, amount: reserves[1]},
        };
    });
}

async function getPendingRewards(contractAddr, poolId, addr) {
    const contract = new ethers.Contract(contractAddr, OhmRewarder, arbitrum);
    return Promise.all([
        contract.rewardToken().then(erc20Info),
        contract.pendingToken(poolId, addr),
    ]).then(([token, pending]) => {
        return {...token, pending};
    });
}

async function miniChefBalances(addr, poolId) {
    const miniChef = new ethers.Contract(miniChefAddress, MiniChefV2, arbitrum);
    return Promise.all([
        miniChef.lpToken(poolId).then(uniswapPairInfo),
        miniChef.SUSHI().then(erc20Info),
        miniChef.pendingSushi(poolId, addr),
        miniChef.rewarder(poolId).then(contractAddr => getPendingRewards(contractAddr, poolId, addr)),
        miniChef.userInfo(poolId, addr),
    ]).then(([lptoken, sushi, pendingSushi, pendingRewards, userInfo]) => {
        const a = new Big(userInfo.amount);
        const b = new Big(lptoken.totalSupply);
        const ratio = a.div(b);
        return {
            liquidity: [
                {...lptoken.token0, balance: ethers.BigNumber.from(ratio.mul(lptoken.token0.amount).round().toString())},
                {...lptoken.token1, balance: ethers.BigNumber.from(ratio.mul(lptoken.token1.amount).round().toString())},
            ],
            pending: [
                pendingRewards,
                {...sushi, pending: pendingSushi},
            ]
        };
    });
}

async function rewarderBalance(poolId) {
    const miniChef = new ethers.Contract(miniChefAddress, MiniChefV2, arbitrum);
    return miniChef.rewarder(poolId).then(rewarderAddr => erc20Balance(gOHM, rewarderAddr));
}

async function cmdBalance() {
    return signer.getAddress().then(addr => {
        return Promise.all([
            signer.getBalance(),
            allErc20Balances(addr),
            miniChefBalances(addr, 12),
            rewarderBalance(12),
        ]);
    }).then(([ethBalance, erc20Balances, lpBalances, rewarderBalance]) => {
        console.log('ETH', ethers.utils.formatUnits(ethBalance, 'ether'));
        erc20Balances.forEach(b => {
            console.log(b.symbol, ethers.utils.formatUnits(b.balance, b.decimals));
        });
        console.log('\nLIQUIDITY');
        lpBalances.liquidity.forEach(b => {
            console.log(b.symbol, ethers.utils.formatUnits(b.balance, b.decimals));
        });
        console.log('\nPENDING');
        lpBalances.pending.forEach(b => {
            console.log(b.symbol, ethers.utils.formatUnits(b.pending, b.decimals));
        });
        console.log('\nREWARDER');
        console.log(rewarderBalance.symbol, ethers.utils.formatUnits(rewarderBalance.balance, rewarderBalance.decimals));
    });
}

async function harvest(poolId, addr) {
    const miniChef = new ethers.Contract(miniChefAddress, MiniChefV2, signer);
    return miniChef.harvest(poolId, addr).then(tx => tx.wait());
}

async function calculateAmountOut(inAddr, amountIn, token0Addr, token1Addr) {
    if (amountIn.eq(ethers.BigNumber.from(0))) {
        return ethers.BigNumber.from(0);
    }
    const router = new ethers.Contract(sushiswapRouter, UniswapV2Router02, arbitrum);
    return router.factory().then(factoryAddr => {
        const factory = new ethers.Contract(factoryAddr, UniswapV2Factory, arbitrum);
        return factory.getPair(token0Addr, token1Addr).then(uniswapPairInfo);
    }).then(({token0, token1}) => {
        const [reserve0, reserve1] = (inAddr === token0.contractAddr) ? [token0.amount, token1.amount] : [token1.amount, token0.amount];
        return router.getAmountOut(amountIn, reserve0, reserve1);
    });
}

async function sellSushi(addr) {
    const sushi = new ethers.Contract(SUSHI, ERC20, arbitrum);
    const lp = new ethers.Contract(sushiswapRouter, UniswapV2Router02, signer);
    const path = [SUSHI, WETH];
    return sushi.balanceOf(addr).then(sushiBalance => {
        return Promise.all([
            sushiBalance,
            calculateAmountOut(SUSHI, sushiBalance, SUSHI, WETH),
        ]);
    }).then(([amountIn, amountOut]) => {
        console.log('sell SUSHI->ETH:', ethers.utils.formatUnits(amountIn, 18), ethers.utils.formatUnits(amountOut, 18));
        if (amountIn.gt(ethers.BigNumber.from(0))) {
            // TODO adjust amountOut to account for slippage?
            return lp.swapExactTokensForETH(amountIn, amountOut, path, addr, calculateDeadline()).then(tx => tx.wait());
        }
    });
}

async function sellGohm(addr) {
    const gohm = new ethers.Contract(gOHM, ERC20, arbitrum);
    const lp = new ethers.Contract(sushiswapRouter, UniswapV2Router02, signer);
    const path = [gOHM, WETH];
    return gohm.balanceOf(addr).then(gohmBalance => {
        const amount = gohmBalance.div(ethers.BigNumber.from(2));
        return Promise.all([
            amount,
            calculateAmountOut(gOHM, amount, gOHM, WETH),
        ]);
    }).then(([amountIn, amountOut]) => {
        console.log('sell gOHM->ETH', ethers.utils.formatUnits(amountIn, 18), ethers.utils.formatUnits(amountOut, 18));
        if (amountIn.gt(ethers.BigNumber.from(0))) {
            // TODO adjust amountOut to account for slippage?
            return lp.swapExactTokensForETH(amountIn, amountOut, path, addr, calculateDeadline()).then(tx => tx.wait());
        }
    });
}

function calculateSlippage(amount, thousandths) {
    return amount.sub(amount.div(ethers.BigNumber.from(1000)).mul(ethers.BigNumber.from(thousandths)));
}

async function addGohmLiquidity(addr) {
    const gohm = new ethers.Contract(gOHM, ERC20, arbitrum);
    const router = new ethers.Contract(sushiswapRouter, UniswapV2Router02, signer);
    return Promise.all([
        signer.getBalance(),
        gohm.balanceOf(addr),
    ]).then(([ethBalance, gohmBalance]) => {
        return Promise.all([
            ethBalance,
            gohmBalance,
            calculateAmountOut(gOHM, gohmBalance, gOHM, WETH),
        ]);
    }).then(([ethBalance, amountGohm, amountEth]) => {
        if (ethBalance.lt(amountEth)) {
            console.log('insufficient ETH for LP');
            return;
        }
        console.log('add liquidity', 'gOHM', ethers.utils.formatUnits(amountGohm, 18), 'ETH', ethers.utils.formatUnits(amountEth, 18));
        const amountTokenMin = calculateSlippage(amountGohm, 5);
        const amountETHMin = calculateSlippage(amountEth, 5);
        return router.addLiquidityETH(gOHM, amountGohm, amountTokenMin, amountETHMin, addr, calculateDeadline(), { value: amountEth }).then(tx => tx.wait());
    });
}

async function depositOnsen(poolId, addr) {
    const miniChef = new ethers.Contract(miniChefAddress, MiniChefV2, signer);
    return miniChef.lpToken(poolId).then(lpAddr => {
        const contract = new ethers.Contract(lpAddr, UniswapV2Pair, arbitrum);
        return contract.balanceOf(addr);
    }).then(balance => {
        console.log('deposit LP', ethers.utils.formatUnits(balance, 18));
        return miniChef.deposit(12, balance, addr).then(tx => tx.wait());
    });
}

async function cmdRoll() {
    return signer.getAddress().then(addr => {
        return harvest(12, addr)
            .then(tx => sellSushi(addr))
            .then(tx => sellGohm(addr))
            .then(tx => addGohmLiquidity(addr))
            .then(tx => depositOnsen(12, addr));
    }).then(tx => console.log('roll done'));
}

async function main() {
    const args = process.argv.slice(2);

    switch (args[0]) {
        case 'balance':
            await cmdBalance();
            break;
        case 'roll':
            await cmdRoll();
            break;
        default:
            console.log('usage:');
            console.log('\nCheck your Proteus balance:');
            console.log('proteus balance');
            console.log('\nRoll your pending SUSHI/gOHM rewards back into the pool:');
            console.log('proteus roll');
    }
}

main();
