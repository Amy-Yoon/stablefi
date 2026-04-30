import { NextRequest } from "next/server";
import { createPublicClient, http, type Abi } from "viem";
import { stableNetChain, STABLENET_TESTNET, CONTRACTS } from "@/lib/chain";
import PositionManagerJson from "@/lib/abi/PositionManager.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PositionManager = PositionManagerJson as Abi;

// ── V3 NFT 미수령 수수료 정확 시뮬레이션 ──────────────────────────────────
// V3 의 `position.tokensOwed0/1` 는 swap 이 사용자 range 를 거쳐갈 때만 갱신됨.
// 그 사이 누적된 fee 는 `feeGrowthInside*` 델타로만 알 수 있는데, on-chain 으로
// 이걸 정확히 뽑으려면 `PositionManager.collect()` 를 simulateContract 로 호출하면
// 그 시점에 collect 가 받게 되는 amount0, amount1 을 정확히 반환함 (실제 tx 는
// 일어나지 않음).
//
// recipient 는 PositionManager 가 NFT 소유자에게만 허용하므로 owner 를 받아서
// `account` 로 simulate. amount0Max / amount1Max 는 uint128 max 로 줘서 모든
// 누적 fee 가 빠져나오게 함.
//
// 입력:
//   ?owner=0x...&tokenIds=1,2,3
//
// 출력:
//   { fees: { [tokenId]: { amount0Raw, amount1Raw } } }

const MAX_UINT128 = (1n << 128n) - 1n;

function makeServerClient() {
  return createPublicClient({
    chain: stableNetChain,
    transport: http(STABLENET_TESTNET.rpcUrl, {
      batch: { batchSize: 32, wait: 16 },
      retryCount: 2,
      retryDelay: 400,
    }),
  });
}

interface PositionFee {
  amount0Raw: string;
  amount1Raw: string;
}

export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner");
  const tokenIdsRaw = req.nextUrl.searchParams.get("tokenIds") ?? "";

  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
    return Response.json({ error: "invalid owner" }, { status: 400 });
  }
  const tokenIds: bigint[] = [];
  for (const part of tokenIdsRaw.split(",").filter(Boolean)) {
    if (!/^\d+$/.test(part)) continue;
    try {
      tokenIds.push(BigInt(part));
    } catch {
      // skip
    }
  }
  if (tokenIds.length === 0) {
    return Response.json({ fees: {} }, { status: 200 });
  }

  const client = makeServerClient();
  const fees: Record<string, PositionFee> = {};

  await Promise.all(
    tokenIds.map(async (tokenId) => {
      try {
        // simulateContract 으로 collect 호출 — 실제 tx 는 일어나지 않고 반환값만.
        // recipient 를 owner 로 두고 amount*Max 를 uint128 max 로 주면, 그 시점에
        // 누적된 모든 fee 가 반환됨. msg.sender (= account) 가 NFT owner 여야 함.
        const { result } = await client.simulateContract({
          account: owner as `0x${string}`,
          address: CONTRACTS.v3PositionManager,
          abi: PositionManager,
          functionName: "collect",
          args: [
            {
              tokenId,
              recipient: owner as `0x${string}`,
              amount0Max: MAX_UINT128,
              amount1Max: MAX_UINT128,
            },
          ],
        });
        const [amount0, amount1] = result as readonly [bigint, bigint];
        fees[tokenId.toString()] = {
          amount0Raw: amount0.toString(),
          amount1Raw: amount1.toString(),
        };
      } catch {
        // 한 포지션 실패해도 다른 건 살림 — 실패 시 0 으로 fallback (기존 tokensOwed 가 사용됨).
        fees[tokenId.toString()] = { amount0Raw: "0", amount1Raw: "0" };
      }
    }),
  );

  return Response.json({ fees });
}
