import { ref, watch } from '@vue/composition-api';
import { getLimits, getUserLimits, SwapAsset } from '@nimiq/fastspot-api';
import { useTransactionsStore, Transaction as NimTransaction } from '../stores/Transactions';
import { SwapEurData, useSwapsStore } from '../stores/Swaps';
import { useBtcTransactionsStore, Transaction as BtcTransaction } from '../stores/BtcTransactions';
import { useFiatStore } from '../stores/Fiat';
import { CryptoCurrency, FiatCurrency } from '../lib/Constants';
import { HTLC_ADDRESS_LENGTH } from '../lib/BtcHtlcDetection';
import { useAccountStore } from '../stores/Account';
import { useAddressStore } from '../stores/Address';
import { useBtcAddressStore } from '../stores/BtcAddress';

const { activeCurrency } = useAccountStore();
const { activeAddress } = useAddressStore();
const { exchangeRates } = useFiatStore();

export type SwapLimits = {
    current: { usd: number, luna: number, sat: number, eur: number },
    monthly: { usd: number, luna: number, sat: number },
    remaining: { usd: number, luna: number, sat: number },
};

const limits = ref<SwapLimits | undefined>(undefined);

const nimAddress = ref<string | undefined>(undefined);
const btcAddress = ref<string | undefined>(undefined);
const isFiatToCrypto = ref(false);

const trigger = ref(0);

watch(async () => {
    // We are using this statement to trigger a re-evaluation (re-run) of the watcher
    trigger.value; // eslint-disable-line no-unused-expressions

    const uid = useAccountStore().activeAccountInfo.value?.uid;
    const userLimitsPromise = uid ? getUserLimits(uid) : Promise.resolve(undefined);

    const nimAddressLimitsPromise = getLimits(
        SwapAsset.NIM,
        nimAddress.value || 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000',
    );
    const btcAddressLimitsPromise = getLimits(
        SwapAsset.BTC,
        btcAddress.value || '1111111111111111111114oLvT2', // Burn address
    );

    // Find historic tx values in USD
    await useTransactionsStore().calculateFiatAmounts(FiatCurrency.USD);
    await useBtcTransactionsStore().calculateFiatAmounts(FiatCurrency.USD);

    const { accountAddresses } = useAddressStore();
    const { activeAddresses } = useBtcAddressStore();

    let newUserLimitEur = Infinity;

    if (isFiatToCrypto.value) {
        const { getSwapByTransactionHash } = useSwapsStore();

        // For fiat-to-crypto swaps, there is a limit of 100€ in the first three days after first use (of the IBAN).
        // So if we find a swap from before three days ago, the regular limits apply.
        // If we only find swaps within the last three days, count them against the 100€ limit.

        type TimedSwap = SwapEurData & { timestamp?: number };

        // Find swaps from EUR
        const nimSwaps = Object.values(useTransactionsStore().state.transactions)
            .map((tx) => {
                // Ignore all transactions that are not on the current account
                if (!accountAddresses.value.includes(tx.recipient)) return false;

                const swap = getSwapByTransactionHash.value(tx.transactionHash);
                // Ignore all swaps that are not from EUR
                if (swap?.in?.asset !== SwapAsset.EUR) return false;

                return {
                    ...swap.in,
                    timestamp: tx.timestamp,
                } as TimedSwap;
            })
            .filter(Boolean) as TimedSwap[];
        const btcSwaps = Object.values(useBtcTransactionsStore().state.transactions)
            .map((tx) => {
                // Ignore all transactions that are not on the current account
                if (!tx.outputs.some((output) => activeAddresses.value.includes(output.address!))) return null;

                const swap = getSwapByTransactionHash.value(tx.transactionHash);
                // Ignore all swaps that are not from EUR
                if (swap?.in?.asset !== SwapAsset.EUR) return false;

                return {
                    ...swap.in,
                    timestamp: tx.timestamp,
                } as TimedSwap;
            })
            .filter(Boolean) as TimedSwap[];

        // Sort them chronologically
        const swaps = [...nimSwaps, ...btcSwaps]
            .sort((a, b) => (a.timestamp || Infinity) - (b.timestamp || Infinity));

        // Check if the first swap happened more than three days ago, otherwise calculate available limit
        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
        if (swaps.length && swaps[0].timestamp && swaps[0].timestamp < (threeDaysAgo.getTime() / 1e3)) {
            // The user is not new, because we found a swap from EUR from more than 3 days ago.
        } else {
            // Sum up swap volume, see how much is left from 100€
            const swapVolume = swaps.reduce((sum, swap) => sum + swap.amount, 0);
            newUserLimitEur = Math.max(0, 100 - (swapVolume / 100));
        }
    }

    const daysAgo30 = new Date();
    daysAgo30.setDate(daysAgo30.getDate() - 30);
    const cutOffTimestamp = daysAgo30.setHours(daysAgo30.getHours() - 3) / 1000;

    // Find NIM tx that were involved in a swap
    const swapNimTxs = Object.values(useTransactionsStore().state.transactions).map((tx) => {
        // Ignore all transactions before the cut-off
        if ((tx.timestamp || Infinity) < cutOffTimestamp) return null;

        // Ignore all transactions that are not on the current account
        if (![tx.sender, tx.recipient].some((address) => accountAddresses.value.includes(address))) return null;

        const swapHash = useSwapsStore().state.swapByTransaction[tx.transactionHash];
        // Ignore all transactions that are not part of a swap
        if (!swapHash) return null;

        return {
            tx,
            swapHash,
        };
    }).filter(Boolean) as ({
        tx: NimTransaction,
        swapHash: string,
    })[];

    const nimSwapHashes = swapNimTxs.map((obj) => obj.swapHash);

    // Find BTC tx that were involved in a swap, but not in a swap with NIM
    const swapBtcTxs = Object.values(useBtcTransactionsStore().state.transactions).map((tx) => {
        // Ignore all transactions before the cut-off
        if ((tx.timestamp || Infinity) < cutOffTimestamp) return null;

        // Ignore all transactions that are not on the current account
        if (!tx.addresses.some((address) => activeAddresses.value.includes(address))) return null;

        const swapHash = useSwapsStore().state.swapByTransaction[tx.transactionHash];
        // Ignore all transactions that are not part of a swap or whose swap is already part of the NIM transactions
        if (!swapHash || nimSwapHashes.includes(swapHash)) return null;

        return {
            tx,
            swapHash,
        };
    }).filter(Boolean) as ({
        tx: BtcTransaction,
        swapHash: string,
    })[];

    const swappedAmount = swapNimTxs.reduce((sum, obj) => {
        const usdValue = obj.tx.timestamp
            ? obj.tx.fiatValue ? obj.tx.fiatValue[FiatCurrency.USD] || 0 : 0
            : (useFiatStore().state.exchangeRates[CryptoCurrency.NIM][FiatCurrency.USD] || 0)
                * (obj.tx.value / 1e5);
        return sum + usdValue;
    }, 0)
    + swapBtcTxs.reduce((sum, obj) => {
        const output = obj.tx.outputs.length === 1
            ? obj.tx.outputs[0]
            : obj.tx.outputs.find((out) => out.address?.length === HTLC_ADDRESS_LENGTH)!;

        const usdValue = obj.tx.timestamp
            ? output.fiatValue ? output.fiatValue[FiatCurrency.USD] || 0 : 0
            : (useFiatStore().state.exchangeRates[CryptoCurrency.BTC][FiatCurrency.USD] || 0)
                * (output.value / 1e8);
        return sum + usdValue;
    }, 0);

    const userLimits = await userLimitsPromise;
    const nimAddressLimits = await nimAddressLimitsPromise;
    const btcAddressLimits = await btcAddressLimitsPromise;

    const lunaRate = (nimAddressLimits.reference.monthly / 100) / nimAddressLimits.monthly;
    const satRate = (btcAddressLimits.reference.monthly / 100) / btcAddressLimits.monthly;

    const monthlyUsdLimit = (userLimits || nimAddressLimits.reference).monthly / 100;

    const currentUsdLimit = Math.max(0, Math.min(
        userLimits ? (userLimits.current / 100) : Infinity,
        nimAddressLimits.reference.monthly / 100 - swappedAmount,
        nimAddress.value ? (nimAddressLimits.reference.current / 100) : Infinity,
        btcAddress.value ? (btcAddressLimits.reference.current / 100) : Infinity,
    ));

    const remainingUsdLimits = Math.max(0, Math.min(
        userLimits ? (userLimits.monthlyRemaining / 100) : Infinity,
        nimAddressLimits.reference.monthly / 100 - swappedAmount,
        nimAddress.value ? (nimAddressLimits.reference.monthlyRemaining / 100) : Infinity,
        btcAddress.value ? (btcAddressLimits.reference.monthlyRemaining / 100) : Infinity,
    ));

    limits.value = {
        current: {
            usd: currentUsdLimit,
            luna: Math.floor(currentUsdLimit / lunaRate),
            sat: Math.floor(currentUsdLimit / satRate),
            eur: newUserLimitEur,
        },
        monthly: {
            usd: monthlyUsdLimit,
            luna: Math.floor(monthlyUsdLimit / lunaRate),
            sat: Math.floor(monthlyUsdLimit / satRate),
        },
        remaining: {
            usd: remainingUsdLimits,
            luna: Math.floor(remainingUsdLimits / lunaRate),
            sat: Math.floor(remainingUsdLimits / satRate),
        },
    };

    // console.log(limits.value); // eslint-disable-line no-console
});

function recalculate() {
    trigger.value += 1;
}

// Re-run limit calculation when address changes
watch([activeCurrency, activeAddress], ([currency, address]) => {
    if (currency === CryptoCurrency.NIM) {
        nimAddress.value = address || undefined;
    } else {
        nimAddress.value = undefined;
    }
}, { lazy: true });

// Re-run limit calculation when exchange rates change
watch(exchangeRates, () => {
    if (limits.value) recalculate();
}, { lazy: true, deep: true });

export function useSwapLimits(options: {
    nimAddress?: string,
    btcAddress?: string,
    isFiatToCrypto?: boolean,
}) {
    nimAddress.value = options.nimAddress;
    btcAddress.value = options.btcAddress;
    isFiatToCrypto.value = options.isFiatToCrypto || false;
    recalculate();

    return {
        limits,
        nimAddress,
        btcAddress,
        recalculate,
    };
}
