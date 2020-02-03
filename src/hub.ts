import HubApi, { Account } from '@nimiq/hub-api'
import { useAccountStore, AccountInfo, AccountType } from './stores/Account';
import { useAddressStore, AddressInfo, AddressType } from './stores/Address'

const hubApi = new HubApi();

function processAndStoreAccounts(accounts: Account[]): void {
    const accountInfos: AccountInfo[] = [];
    const addressInfos: AddressInfo[] = [];

    const accountStore = useAccountStore();
    const addressStore = useAddressStore();

    for (const account of accounts) {
        const addresses: string[] = [];

        for (const address of account.addresses) {
            addresses.push(address.address);

            addressInfos.push({
                address: address.address,
                type: AddressType.BASIC,
                label: address.label,
                balance: addressStore.state.addressInfos[address.address]
                    ? addressStore.state.addressInfos[address.address].balance
                    : null,
            });
        }

        for (const contract of account.contracts) {
            addresses.push(contract.address);

            addressInfos.push({
                ...contract,
                balance: null,
            });
        }

        accountInfos.push({
            id: account.accountId,
            // @ts-ignore Type 'WalletType' is not assignable to type 'AccountType'. (WalletType is not exported.)
            type: account.type,
            label: account.label,
            fileExported: account.fileExported,
            wordsExported: account.wordsExported,
            addresses,
        });
    }

    accountStore.setAccountInfos(accountInfos);
    addressStore.setAddressInfos(addressInfos);
}

export async function syncFromHub() {
    let listedAccounts: Account[];
    try {
        listedAccounts = await hubApi.list();
    } catch (error) {
        if (error.message === 'MIGRATION_REQUIRED') {
            // @ts-ignore Argument of type 'RedirectRequestBehavior' is not assignable to parameter of type 'RequestBehavior<BehaviorType.POPUP>'.
            hubApi.migrate(new HubApi.RedirectRequestBehavior());
            return;
        }

        // TODO: Handle this case with a user notification
        else if (error.message === 'ACCOUNTS_LOST') listedAccounts = [];

        // TODO: Handle error
        else throw error;
    }

    processAndStoreAccounts(listedAccounts);
}

export async function onboard() {
    let listedAccounts: Account[];

    try {
        listedAccounts = await hubApi.onboard({ appName: "Safe NXT" });
    } catch(error) {
        // TODO: Handle error
        throw error;
    }

    processAndStoreAccounts(listedAccounts);
}

export async function addAddress() {
    alert('nope');
}
