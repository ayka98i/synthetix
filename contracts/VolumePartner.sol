pragma solidity ^0.5.16;

// Inheritance
import "./Owned.sol";
import "./Proxyable.sol";
import "./LimitedSetup.sol";
import "./MixinResolver.sol";
import "./MixinSystemSettings.sol";
import "./interfaces/IVolumePartner.sol";

// Libraries
import "./SafeDecimalMath.sol";

// Internal references
import "./interfaces/ISynth.sol";
import "./interfaces/IExchanger.sol";
import "./interfaces/IIssuer.sol";
import "./interfaces/IFuturesMarketManager.sol";

// https://docs.synthetix.io/contracts/source/contracts/volumepartner
contract VolumePartner is Owned, Proxyable, LimitedSetup, MixinSystemSettings, IVolumePartner {
    using SafeMath for uint;
    using SafeDecimalMath for uint;

    bytes32 public constant CONTRACT_NAME = "VolumePartner";

    // Where fees are pooled in sUSD.
    address public constant FEE_ADDRESS = 0x0000fEefEeFeEFEEfEefeEfEEFeEfeefEEFEEfEE;

    // sUSD currencyKey. Fees stored and paid in sUSD
    bytes32 private sUSD = "sUSD";

    struct VolumePartnerData {
        address owner;
        uint feeRate;
        uint balance;
        address nominatedOwner;
    }

    mapping(bytes32 => VolumePartnerData) public volumePartnerData;

    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */

    bytes32 private constant CONTRACT_EXCHANGER = "Exchanger";
    bytes32 private constant CONTRACT_ISSUER = "Issuer";
    bytes32 private constant CONTRACT_FUTURES_MARKET_MANAGER = "FuturesMarketManager";

    constructor(
        address payable _proxy,
        address _owner,
        address _resolver
    ) public Owned(_owner) Proxyable(_proxy) LimitedSetup(3 weeks) MixinSystemSettings(_resolver) {}

    /* ========== VIEWS ========== */

    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        bytes32[] memory existingAddresses = MixinSystemSettings.resolverAddressesRequired();
        bytes32[] memory newAddresses = new bytes32[](3);
        newAddresses[0] = CONTRACT_EXCHANGER;
        newAddresses[1] = CONTRACT_ISSUER;
        newAddresses[2] = CONTRACT_FUTURES_MARKET_MANAGER;
        addresses = combineArrays(existingAddresses, newAddresses);
    }

    function futuresMarketManager() internal view returns (IFuturesMarketManager) {
        return IFuturesMarketManager(requireAndGetAddress(CONTRACT_FUTURES_MARKET_MANAGER));
    }

    function exchanger() internal view returns (IExchanger) {
        return IExchanger(requireAndGetAddress(CONTRACT_EXCHANGER));
    }

    function issuer() internal view returns (IIssuer) {
        return IIssuer(requireAndGetAddress(CONTRACT_ISSUER));
    }

    function getFeeRate(bytes32 volumePartnerCode) external view returns (uint) {
        return volumePartnerData[volumePartnerCode].feeRate;
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    function registerVolumePartnerCode(
        bytes32 volumePartnerCode,
        address volumePartnerCodeOwner,
        uint feeRate
    ) external {
        require(
            volumePartnerData[volumePartnerCode].owner == address(0),
            "This volume partner code has already been registered."
        );
        require(volumePartnerCodeOwner != address(0), "Owner cannot be the zero address.");
        require(feeRate <= getMaxVolumePartnerFee(), "Fee rate must be less than or equal to the maximum.");

        volumePartnerData[volumePartnerCode].owner = volumePartnerCodeOwner;
        volumePartnerData[volumePartnerCode].feeRate = feeRate;

        emit VolumePartnerCodeRegistered(volumePartnerCode, volumePartnerCodeOwner, msg.sender, feeRate);
    }

    function accrueFee(bytes32 volumePartnerCode, uint amount) external onlyInternalContracts {
        issuer().synths(sUSD).issue(FEE_ADDRESS, amount);
        volumePartnerData[volumePartnerCode].balance = volumePartnerData[volumePartnerCode].balance.add(amount);
        emit FeesAccrued(volumePartnerCode, msg.sender, amount);
    }

    function claimFees(bytes32 volumePartnerCode, address recipientAddress) external notFeeAddress(recipientAddress) {
        require(
            msg.sender == volumePartnerData[volumePartnerCode].owner,
            "You are not the owner of this volume partner code"
        );
        require(recipientAddress != address(0), "Recipient cannot be the zero address.");

        uint sUSDAmount = volumePartnerData[volumePartnerCode].balance;
        require(sUSDAmount > 0, "This volume partner code has no fees available.");

        volumePartnerData[volumePartnerCode].balance = 0;

        // Grab the sUSD Synth
        ISynth sUSDSynth = issuer().synths(sUSD);

        // NOTE: we do not control the FEE_ADDRESS so it is not possible to do an
        // ERC20.approve() transaction to allow this feePool to call ERC20.transferFrom
        // to the accounts address

        // Burn the source amount
        sUSDSynth.burn(FEE_ADDRESS, sUSDAmount);

        // Mint their new synths
        sUSDSynth.issue(recipientAddress, sUSDAmount);

        emit FeesClaimed(volumePartnerCode, msg.sender, recipientAddress, sUSDAmount);
    }

    function updateFeeRate(bytes32 volumePartnerCode, uint feeRate) external {
        require(
            msg.sender == volumePartnerData[volumePartnerCode].owner,
            "You are not the owner of this volume partner code"
        );
        require(feeRate <= getMaxVolumePartnerFee(), "Fee rate must be less than or equal to the maximum.");

        volumePartnerData[volumePartnerCode].feeRate = feeRate;

        emit FeeRateUpdated(volumePartnerCode, msg.sender, feeRate);
    }

    function nominateOwner(bytes32 volumePartnerCode, address nominee) external {
        require(
            msg.sender == volumePartnerData[volumePartnerCode].owner,
            "You are not the owner of this volume partner code"
        );
        volumePartnerData[volumePartnerCode].nominatedOwner = nominee;
        emit OwnerNominated(volumePartnerCode, nominee);
    }

    function acceptOwnership(bytes32 volumePartnerCode) external {
        require(
            msg.sender == volumePartnerData[volumePartnerCode].nominatedOwner,
            "You are not the nominated owner of this volume partner code"
        );
        emit OwnershipAccepted(
            volumePartnerCode,
            volumePartnerData[volumePartnerCode].owner,
            volumePartnerData[volumePartnerCode].nominatedOwner
        );
        volumePartnerData[volumePartnerCode].owner = volumePartnerData[volumePartnerCode].nominatedOwner;
        volumePartnerData[volumePartnerCode].nominatedOwner = address(0);
    }

    /* ========== Modifiers ========== */

    modifier notFeeAddress(address account) {
        require(account != FEE_ADDRESS, "Fee address not allowed");
        _;
    }

    function _isInternalContract(address account) internal view returns (bool) {
        return account == address(exchanger()) || futuresMarketManager().isMarket(account); // just change this to get futuresmarketmanager and then have an accrue fees proxy call like issueSUSD in the uturemarketsmanager contract
    }

    modifier onlyInternalContracts {
        require(_isInternalContract(msg.sender), "Only Internal Contracts");
        _;
    }

    // ========== EVENTS ==========
    event VolumePartnerCodeRegistered(
        bytes32 indexed volumePartnerCode,
        address indexed owner,
        address indexed caller,
        uint feeRate
    );
    event FeeRateUpdated(bytes32 indexed volumePartnerCode, address indexed caller, uint feeRate);
    event FeesAccrued(bytes32 indexed volumePartnerCode, address indexed source, uint amount);
    event FeesClaimed(bytes32 indexed volumePartnerCode, address indexed caller, address indexed recipient, uint amount);
    event OwnerNominated(bytes32 indexed volumePartnerCode, address indexed nominee);
    event OwnershipAccepted(bytes32 indexed volumePartnerCode, address indexed previousOwner, address indexed newOwner);
}