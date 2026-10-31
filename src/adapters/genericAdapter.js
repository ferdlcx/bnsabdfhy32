/**
 * Generic Contract Adapter untuk mengeksekusi skill Web3 baru yang di-import melalui Universal Skill Loader
 * atau pemanggilan kontrak yang telah masuk dalam Contract Allowlist.
 */
class GenericContractAdapter {
  constructor(options = {}) {
    this.walletService = options.walletService;
    this.txGuard = options.txGuard;
  }

  async prepareContractCall({
    userId,
    project = "custom",
    title = "Custom Contract Call",
    chainId = "56",
    to,
    inputData = "0x",
    valueWei = "0",
    estimatedSpendUsd = 0,
    requireAllowlist = true,
  }) {
    const walletAddress = await this.walletService.getAddressForChain(chainId);
    if (!walletAddress) {
      throw new Error("Wallet BAW belum terhubung. Jalankan `/status` atau `/auth`.");
    }

    this.txGuard.validateTransactionParams({
      chainId,
      walletAddress,
      to,
      inputData,
      valueWei,
      estimatedSpendUsd,
      requireAllowlist,
    });

    const previewRes = await this.walletService.previewContractCall({
      chainId,
      from: walletAddress,
      to,
      valueWei,
      inputData,
    });

    if (!previewRes.ok) {
      throw new Error(
        `Preview kontrak gagal: ${previewRes.error?.message || previewRes.raw || "Unknown error"}`
      );
    }

    const pendingRecord = this.txGuard.createPendingTransaction({
      userId,
      project,
      title,
      walletAddress,
      chainId,
      steps: [
        {
          stepNumber: 1,
          label: title,
          to,
          valueWei,
          inputData,
          requestId: previewRes.data?.requestId,
          previewData: previewRes.data,
        },
      ],
      estimatedSpendUsd,
      summary: {
        contract: to,
        valueWei,
        calldataPreview: inputData.length > 42 ? `${inputData.slice(0, 42)}...` : inputData,
      },
      requireAllowlist,
    });

    return {
      pendingRecord,
      preview: previewRes.data,
    };
  }
}

module.exports = {
  GenericContractAdapter,
};
