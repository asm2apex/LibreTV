// 签名模块常量 —— 唯一实现依据 docs/protocol/01-signing.md（下称"规格"），出处均指该文引用的 file:line。
// 小表 = 规格 §4 内联值；四个大表（SBOX1024/TT02/SV2/B2ORDERS）规格只给 file:line，
// 由 references/hongguo_tvbox.py（[T]）机械提取数据（脚本生成本文件，未手抄），并已与 [P] pure-sign.js 交叉核对。
// 语境：红果（hongguo，[T]/[P]）与番茄（fanqie，[D]）常量不通用（规格 §1）。
import { Buffer } from 'node:buffer';

// ===== gorgon（规格 §3.3）=====
export const GORGON_HEADER = Uint8Array.of(0x84, 0x04); // 输出头版本标记，规格 §4 [D:474] [T:3076]
// 密钥骨架 [0x4A, param_lo, 0x16, hb3, 0x47, 0x6C, param_hi, hb2]，规格 §3.3.2 [D:453] [T:3070] [P:458]
export const SDK_NUM_HONGGUO = 0x04060400; // 种子固定段：红果 metasec SDK 数值，规格 §9.1 [T:3069] [P:456]
export const SDK_NUM_FANQIE = 0x04070100; // 番茄 SDK 数值，规格 §9.1 [D:439]
export const GORGON_PARAM_HONGGUO = 320; // parameter 红果固定值，规格 §9.2 [T:3070] [D:493]

// ===== ladon/helios 同一算法的两组语境常量（规格 §3.4）=====
export const FANQIE_LADON = { licenseId: 1611921764, appId: 3019 } as const; // [D:139-140] 明文 "{ts}-1611921764-3019"
export const HONGGUO_HELIOS = { licenseId: 1588093228, appId: 8662 } as const; // [T:3100] [P:768,838] 明文 "{ts}-1588093228-8662"
// 注：红果实算 x-ladon 规格未单独给常量（[T]/[P] 均以存根部署，§3.2）；index.ts 复用 HONGGUO_HELIOS 三元组（§3.4 同一算法）。

// ===== argus（规格 §3.5，番茄语境常量）=====
export const ARGUS_SIGN_KEY = Buffer.from(
  'ac1adaae95a7af94a5114ab3b3a97dd80050aa0a39314c40528caec95256c28c',
  'hex',
); // 32B [D:134]
export const ARGUS_HEADER = Buffer.from('3ccc', 'hex'); // 输出前缀 2B + simonKey 派生 4B 的一半 [D:135]
export const ARGUS_PREFIX = Buffer.from('a6e783ee7001100918', 'hex'); // container 前缀 9B [D:136]
export const ARGUS_SUFFIX = Buffer.from('567b', 'hex'); // container 后缀 2B [D:137]
export const ARGUS_XOR_WORD = [0xd0, 0x4f, 0xfd, 0xff]; // XOR 段 4B（重复两遍成 8B）[D:138]
export const ARGUS_SDK_VERSION = 135135744; // proto f9 = 0x080E0000 [D:141]
export const ARGUS_COUNTER_VALUE = 1388734; // proto f15 嵌套 2/3/4 [D:142]
// Simon 类密钥扩展 z 序列（非官方参数组合 m=4/72 轮/z4，规格 §3.5.2）[D:143]；位序从最低位起数
export const SIMON_Z4 = 0x3dc94c3a046d678bn;
export const ARGUS_METASEC_APP_ID_STR = '3019'; // proto f4（十进制字符串）[D:140] §3.5.1
export const ARGUS_LICENSE_ID_STR = '1611921764'; // proto f6 [D:139] §3.5.1
export const ARGUS_EMBEDDED_SDK_VER = '6.8.1.32'; // proto f7：内嵌 SDK 串，非 App 版本（§3.5.1）
export const ARGUS_SDK_STR_FANQIE = 'v04.07.01-ml-android'; // proto f8 [D:329]

// ===== medusa（规格 §3.6，红果语境常量）=====
export const MEDUSA_SIGN_KEY = Buffer.from(
  '8ebdfa3806ecc5cee79423e6029ed82540bc2218bb7eaef71cb691f7aa8aa2f5',
  'hex',
); // keyHash 输入 [T:3197] [P:698-699]
export const MEDUSA_AES_KEY = Buffer.from('f1593376766ea98d34f31b057a9d5be4', 'hex'); // AesV3 密钥 [T:3195] [P:700]
export const MEDUSA_AES_IV = Buffer.from('1fe109a4125283f418de9e051a969e12', 'hex'); // AesV3 IV [T:3196] [P:701]
// proto f1 / 输出 ver 段（20B = 03000000 + 下 16B）[T:3156,3211] [P:702,799]
export const MEDUSA_MAGIC16 = Buffer.from('f7e85ffad7d7dc3bd62ac87057cf6118', 'hex');
// 组装前缀 / proto f10 = LE64(320) [T:3160,3203] [P:703,784]
export const MEDUSA_MAGIC8 = Buffer.from('4001000000000000', 'hex');
export const MEDUSA_VER = Buffer.concat([Buffer.from('03000000', 'hex'), MEDUSA_MAGIC16]); // 20B，规格 §3.6.6

export const GET_IV_INIT = 0x20230928; // hashF13 IV（日期 2023-09-28）[T:2621] [P:347]
export const SUM_MD5_INIT = 0x20220420; // sumMd5 初值（日期 2022-04-20）[T:2462] [P:228]

// hashF13 branch0 表（规格 §3.6.1/§4）
export const TT01 = [0xc4a78580, 0xb3c0fd39, 0xc58c5686, 0xc9aa3ba7, 0xf5a7adf2, 0x963c2ed1]; // [T:2637] [P:357]
// TT02：hashF13 branch0 轮表（64×u32），规格 §4 [T:2643-2650] / [P:361-369]，机械提取
export const TT02: readonly number[] = [
  0xebb64faf, 0x07aadcc2, 0xcf3187bf, 0xe01138ff, 0x6d0bfcff, 0x5a30a3be, 0xb41ad638, 0x34180eb8,
  0xf233eb6f, 0xb1a584cc, 0xccc30dc7, 0x47d1db51, 0xd55653de, 0x70a84fa1, 0x57473c12, 0xf76f0288,
  0x2c077f0a, 0xda0dcad0, 0xfbb86f6c, 0xfdc4cf00, 0x688a020d, 0xe676c6a6, 0x8cd6338b, 0x1a3c8d0e,
  0xcce8b06b, 0x6ad0ed0b, 0xa0522717, 0xdc71ac83, 0x2285db71, 0xd5b4dda6, 0x736f8650, 0x6560306c,
  0x617ce2a6, 0xe423417e, 0x0a40e143, 0x544e4032, 0x88dffb2a, 0x716c1ae0, 0x4c467a88, 0x05b23bb3,
  0xe1d0b866, 0xbaa3dcb8, 0xae3374d3, 0xc3381a50, 0x1702f75b, 0xfe6da368, 0xf0b4cf48, 0x4e0ffbb8,
  0x72aad10d, 0x26c53a3d, 0xf2bce0f6, 0xb4557581, 0x4a257fdd, 0x8c3182a2, 0xab0b3b86, 0x3d5dfb14,
  0x4f103634, 0xd37b52d7, 0x444eff16, 0xeb0a33d1, 0x6ca86f6e, 0x00284ba7, 0x08387cfa, 0x5fb37586,
];
// INIT8：末 4 项规格同时给十进制源值 984304912/3005047866/2874125293/2152413264（已换算核对）[T:2666-2671] [P:391-392]
export const INIT8 = [
  0x7aba4fc8, 0x67166507, 0x6403fa00, 0x340f512f, 0x3aab4d10, 0xb31d643a, 0xab4fabed, 0x804b3850,
];
// CHOSEN[ivV0] = [轮数, c1..c10]（branch0 轮函数字索引），规格 §4【已验证 双侧对照】[P:395-401] / [T:2687-2698]
export const CHOSEN: readonly (readonly number[])[] = [
  [101, 5, 7, 6, 3, 2, 1, 0, 5, 4, 3],
  [96, 0, 6, 7, 5, 3, 2, 1, 5, 4, 4],
  [96, 7, 6, 2, 1, 4, 0, 5, 4, 3, 5],
  [99, 3, 6, 2, 4, 5, 1, 0, 0, 7, 6],
  [96, 0, 5, 6, 7, 3, 1, 2, 5, 4, 4],
  [100, 2, 0, 3, 5, 4, 6, 7, 2, 1, 5],
];
export const BRANCH0_PAD_SEED = [0xfa, 0x45, 0x61, 0xd7]; // branch0 pad 种子 [T:2659] [P:373]

// hashF13 branch2 表（规格 §3.6.1/§4）
export const B2_T001 = [0x8980f29b, 0xeb549c7f, 0xb08726db, 0xd40cb5e6, 0xe8f559e4]; // [T:2851] [P:330]
// SV2：hashF13 branch2（md5sum_v3）轮常数表（64×u32），规格 §4 [T:2479-2486] / [P:240-248]，机械提取
export const SV2: readonly number[] = [
  0xa7aefe20, 0x7149f1d6, 0x47e4ca07, 0xe9b58f67, 0x93b924de, 0xc614d0f5, 0x38afe0ef, 0xb2bbad73,
  0xe24444c3, 0x9d3aec9b, 0xdf7b37e4, 0xd8b16d40, 0xf8ac31b8, 0x76b9a90b, 0x31d833ee, 0x953fce64,
  0x353595a4, 0x4609c13b, 0x36925008, 0x8c6d0925, 0x5df5c177, 0x1cfbf52b, 0x8a4fa7f0, 0x114ca35e,
  0x8193f984, 0x7a7a8733, 0x316ab4d5, 0x3c20cfc9, 0xa6d84453, 0x3a18500c, 0x798ec47a, 0x97a76b28,
  0x66c4ff96, 0x51716443, 0x0dd2fc3b, 0xb5696da7, 0xbbeb3ac5, 0x5c53d204, 0xd32608ce, 0x7279b9ec,
  0xf4188ecf, 0xf7d793db, 0x332cc491, 0xab76ae15, 0x9bebe727, 0x18a01384, 0x5be9f8a7, 0x5f90a754,
  0x39b663c0, 0x36673c83, 0x7c92f514, 0x9d7d94d7, 0xe2e8d9aa, 0x5f7e9ea9, 0x7abd4551, 0x569e05da,
  0x40a25632, 0x3df5a9a5, 0xbab37d80, 0x454286dc, 0x3f5d4e78, 0x03d7b75d, 0xb1fe4af7, 0xa5ab26a3,
];
export const B2_START4 = [0x79e0f2fb, 0xc8b52570, 0xebc2f8cd, 0x7c104d93]; // [T:2495-2499] [P:285-288]
export const B2_END4 = [0x19be4866, 0xe85986b4, 0xe19b326e, 0x71d1d7d4]; // [T:2502-2508] [P:289-291]
export const BRANCH2_PAD_SEED8 = [0x84, 0x96, 0x77, 0x9d, 0xd4, 0x15, 0x0b, 0xf8]; // [T:2860] [P:334]
// B2ORDERS：branch2 消息字下标重排表，5 组×64 字节（规格 §4 标"80 字节"系笔误，实际 320B），
// branch2 按 ivV0'<<6 取 64 字节段；[T:2839-2845] / [P:250-270]，机械提取
export const B2ORDERS: Uint8Array = Buffer.from(
  "0f0704000908030a060b050d0e010c020f05080c0009020103070e060b0a0d04060500070c000a04080f010b0d09020e060b02050403080101070a000d0c090e" +
  "0d070e0f0b0208030c0509010004060a0d0902060f0b0a040807000c0503010e0c090f07060f030e020d0405010b0a000c050a090e0802040407030f01060b00" +
  "0b0f0408020a0700090d06010e03050c0b060a0508020c03070f0e090d0001040906080f050800040a0b030d01020c0e090d0c0604070a03030f00080105020e" +
  "01000d0f090a0b0e0402080703060c0501080a0c0f0905060b000304020e070d04080f000c0f0e0d0a01060207090503040205080d0b0a0606000e0f070c0903" +
  "0a08040f000b01060d0c0709030e05020a070b050f00020e0108030d0c0609040d070f08050f06040b0a0e0c090002030d0c020704010b0e0e08060f09050003",
  "hex",
);

// ===== AesV3（规格 §3.6.5）=====
// SBOX1024：AesV3 的 4×256B S 盒段（规格 §3.6.5/§4）。
// 提取自 [T:2148-2215]（b'.join 字节串），与 [P:471-473] base64 解码 sha256 一致。
// sha256(SBOX1024) = c1e407db754f4c2938d3f658d7278b2b862d20e5dc8578990006db1739bba167   ← 规格锚定值（§3.6.5），medusa.test.ts 持续校验
// 首 16 字节 = fa7d086b9c59b34b045f39d0384a9199（规格 §3.6.5 给出）
export const SBOX1024: Uint8Array = Buffer.from(
  'fa7d086b9c59b34b045f39d0384a91990067a6209ff54d827326eedf18668333' +
  '800319fbd9feaeaaa9b052c60bf379254e78b436ac5d1a279e88dbbd3c63ec49' +
  '15c1301fdcb856d46ccdca0943c835a3ef1ef496d2fc0e727b9484d1ea455a62' +
  '023fd31281342bdd7ee628f2a54613013b21f66137292a0ded8cafbf9d5cbb24' +
  '760f75e45389e1988db19a65704f544c58ab6e6f8b23c407110cbacfa0a48ed8' +
  '053d14b2da74c3d7e7bed67fde48163e8590a155b7774222c986502e17f96431' +
  '2c9bf16d1c4468e3e9a89397cb3257ebe5716aadc0ccc7c5fd601da22d47a7e2' +
  '51695e7ace0a41b6958ff7b987e03a06108ab5f85bd5f0bc92ff7c2fc2e81b40' +
  'ec1bdabdba98910cb22b83413467fb0ad876b546055961237590872ae350154c' +
  'acb179ebaee595470468f0863d518b0fca8ee4b94ef21282bc0ed5f7ef2825cf' +
  '5b5de96a5502e133be93e7f5ad9d3e3924a8e2fa1757d07a0d0830d6b8a38dfd' +
  '079ac41e6e226497d21db0bf45663f6cdddb2780a711dca6c552f8c0b6c85c00' +
  '73607ba01913aac935484bd3a4cd9f99f3104440547e29f4061fa2aba12f3cf6' +
  'af856236217f5edf201ab3b4e6ff72848f6526945a77ea4378c74acc2c146bc6' +
  'e87453fcd41cce317003188c96383289f13a5fd7f9a969b7633758c23bc371cb' +
  '9e92018a0b4d889bbb4f6d6fe0fea549de561609ed9cc12dee817dd97cd12e42' +
  '5b4dc1a65dea44fd454e1ba13fd189e17d2faadbabad59cbb1ce9a28c9e0f670' +
  '394ad7ff30f5ddbc573b118db2ee00b6e61a5a7cf9dec4cd2e80bbb94ca59f84' +
  '08c66f426cf027e78b3a9c51fb6721754131a7ca20432ab7bfd97af2b5f88c2c' +
  '23834f8f60a004133714e301c563665c7481df58bd68903dd2b334f419933229' +
  'd649ae0d4bd8079eac1e2d0b40b872ba761071a8e4561d48fee5c24791da8726' +
  '9d1f886bc098be25099733a385165e7fdc6e54e9f7a9c8e8c377d0822bec0262' +
  '8a920e3eb00f05f3f19678388636183c24cf0ab453cc6165a4c794d5157e6def' +
  '792235126a8e5206557b46645095e20cedd31703a29b99eb1cfcafd47369fa5f' +
  'f72c1ebfc8e1f39f76807148aa94ad64fb89c660c332b34dd2e044dd5fa8b1c7' +
  '682334c96d127fb7eb15bea9d17893a00c92a4d747e38ac270ab26419a79a7d8' +
  '14858fc06f56d08c11b92e3ce29dcf0ede035d463ecd38430f335ad91a656c22' +
  '3bfc30a688ea37a2b48d8e519cd640eef9f884f4ae97e9ca0a456757042f835c' +
  'd5c5c482b6a391981f4aac96816ecb1b0908af1895497d54edfa16313adab866' +
  'f5a5f1fe10010674cc63df7c2825f6ceb24f8be5bc8769bb8621070036e70b50' +
  '599b1ce862581961f2bd275eba1de699423d0d2ab5dc5b29f02d4c537b6a734e' +
  '3f75ff4ba1351755723920d3b0fdef02ec777ee42bdb90c1059e7ad4526b2413',
  'hex',
);
export const AES_V3_INIT = [0xca025ddc, 0x823dc546, 0xc9420583, 0xc298225f]; // 密钥扩展初值（按 ws=khronos&3 选）[T:2239] [P:529]
export const AES_V3_CON2: readonly (readonly number[])[] = [
  [1, 0, 2, 3],
  [2, 0, 3, 1],
  [0, 1, 3, 2],
  [1, 0, 2, 3],
]; // 列重排表 [T:2218] [P:521]
export const AES_V3_ORDERS: readonly (readonly number[])[] = [
  [0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3],
  [0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11],
  [0, 9, 14, 7, 4, 13, 2, 11, 8, 1, 6, 3, 12, 5, 10, 15],
  [0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3],
]; // 字节重排表 [T:2219-2222] [P:522-526]

// ===== medusa protobuf 固定值（规格 §3.6.2）=====
export const MEDUSA_AID_STR = '8662'; // f4 / device f3 [T:3100]
export const MEDUSA_LICENSE_STR = '1588093228'; // f6
export const MEDUSA_VERSION_NAME = '7.1.3.32'; // f7 / env f14
export const MEDUSA_SDK_STR = 'v04.06.04-ml-android'; // f8
export const MEDUSA_SDK_NUM = 67503104; // f9 = 0x04060400 [T:3159] [P:769]
export const MEDUSA_CALL_TYPE = 312; // f21 [T:3163]
export const MEDUSA_PSK = 'none'; // f20
export const MEDUSA_FIXED_JSON =
  '{"cmr":16777216,"cmr2":16777216,"un_h":1879194040,"vpn":0,"kd":0,"fkd":3672518972,"pd":-1872573247,"dyn":"","do":0,"tk":true}'; // f24 固定串 [T:3165]
export const MEDUSA_F15 = { signCount: 111, unknown2: 10, unknown3: 694367, unknown5: 586952199 }; // 固定嵌套 [T:2949-2955]
export const ENV_UNKNOWN2 = 146331399; // env f2
export const ENV_UNKNOWN3 = 146331396; // env f3
export const ENV_UNKNOWN5 = 7; // env f5
export const ENV_SDK_BUGFIX = 'v04.06.04.03-bugfix'; // env f6 [T:3129]
export const ENV_REPORT_STATE = -2; // env f13.2
export const ENV_REPORT_CODE = 200; // env f13.4
export const DEVICE_NO_PERM = '!noperm!'; // device f6 [T:3131]
export const DEVICE_BATTERY = -888888; // device f7/8/10 [T:3132-3134]
export const DEVICE_BATTERY_HEALTH = 3; // device f9
export const DEVICE_NOT_SET = '!notset!'; // device f11
export const DEVICE_TZ = 'Asia/Shanghai,8'; // device f12
export const DEVICE_LANG = 'zh_CN'; // device f13
export const DEVICE_CPU = 4; // device f14
export const DEVICE_OS_VERSION = '16'; // device f22
export const DEVICE_BRIGHTNESS = 41; // device f23
export const DEVICE_VOLUME = 36; // device f24
export const DEVICE_USB = -1; // device f29
export const DEVICE_MODEL = '25053RT47C'; // f30/f32/f33 [T:3255-3256]
export const DEVICE_BOARD = 'Redmi'; // f31
export const DEVICE_MANUFACTURER = 'Xiaomi'; // f34
export const DEVICE_BRAND = 'Redmi'; // f35
export const DEVICE_HARDWARE = 'Redmi'; // f36
export const DEVICE_UNKNOWN38 = 31; // f38
