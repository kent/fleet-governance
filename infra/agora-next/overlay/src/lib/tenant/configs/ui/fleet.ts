import { TenantUI } from "@/lib/tenant/tenantUI";
import TenantTokenFactory from "@/lib/tenant/tenantTokenFactory";
import { TENANT_NAMESPACES } from "@/lib/constants";

const TRANSPARENCY_NOTICE =
  "Fleet Governance shows the fleet's proposals, votes and delegates from chain data and its archive. Approval and execution are separate events. In deployments with FleetExecutor, the artifact store accepts only exact, settled permissions. Tool access is checked by the fleet's gateway. This site displays the record; it does not grant execution authority.";

export const fleetTenantUIConfig = new TenantUI({
  title: "Fleet Governance",
  logo: "/fleet-logo.svg",
  tokens: [TenantTokenFactory.create(TENANT_NAMESPACES.FLEET)],

  assets: {
    success: "/fleet-logo.svg",
    pending: "/fleet-logo.svg",
    delegate: "/fleet-delegate.svg",
  },

  organization: {
    title: "Fleet Governance",
  },

  delegates: {
    allowed: [],
    advanced: [],
    retired: [],
  },

  customization: {
    primary: "17 24 39",
    secondary: "31 41 55",
    tertiary: "75 85 99",
    neutral: "255 255 255",
    wash: "249 250 251",
    line: "209 213 219",
    positive: "22 163 74",
    negative: "220 38 38",
    brandPrimary: "56 189 248",
    brandSecondary: "243 244 246",
  },

  links: [],

  governanceIssues: [],

  pages: [
    {
      route: "/",
      title: "Fleet Governance",
      description: TRANSPARENCY_NOTICE,
      meta: {
        title: "Fleet Governance",
        description: TRANSPARENCY_NOTICE,
        imageTitle: "Fleet Governance",
        imageDescription: TRANSPARENCY_NOTICE,
      },
    },
    {
      route: "delegates",
      title: "Fleet delegates",
      description:
        "The members of this fleet hold voting power over its proposals. This list and each member's voting power come from DAO Node, read live from the chain, not from a database snapshot.",
      meta: {
        title: "Fleet Governance: Delegates",
        description:
          "The members of this fleet hold voting power over its proposals, read live from DAO Node.",
        imageTitle: "Fleet Governance: Delegates",
        imageDescription:
          "The members of this fleet hold voting power over its proposals, read live from DAO Node.",
      },
    },
    {
      route: "proposals",
      title: "Fleet proposals",
      description: TRANSPARENCY_NOTICE,
      meta: {
        title: "Fleet Governance: Proposals",
        description: TRANSPARENCY_NOTICE,
        imageTitle: "Fleet Governance: Proposals",
        imageDescription: TRANSPARENCY_NOTICE,
      },
    },
  ],

  toggles: [
    {
      name: "proposals",
      enabled: true,
    },
    {
      name: "delegates",
      enabled: true,
    },
    {
      name: "use-archive-for-proposals",
      enabled: true,
    },
    {
      name: "use-archive-for-proposal-details",
      enabled: true,
    },
    {
      name: "use-archive-for-vote-history",
      enabled: true,
    },
    {
      name: "use-daonode-for-voting-power",
      enabled: true,
    },
    {
      name: "use-daonode-for-votable-supply",
      enabled: true,
    },
    {
      name: "use-daonode-for-proposal-types",
      enabled: true,
    },
    {
      name: "delegates/edit",
      enabled: false,
    },
    {
      name: "sponsoredVote",
      enabled: false,
    },
    {
      name: "sponsoredDelegate",
      enabled: false,
    },
  ],
});
