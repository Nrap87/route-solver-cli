/**
 * Minimal OpenAPI-style `components` slice used by `solver/adapters.ts`.
 * Aligns with majos95/route-solver-web Star Delivery types; expand as needed.
 */
export interface components {
  schemas: {
    PlanetOut: {
      Id?: number;
      Name?: string;
      Coordinate_X?: number;
      Coordinate_Y?: number;
    };
    RouteOut: {
      From_Planet?: number;
      To_PlanetId?: number;
      RouteType?: string;
    };
    ChallengeOut: {
      StartPlanetId?: string;
      MandatoryPlanets?: Array<{ PlanetId?: number | null }>;
      ForbiddenPlanets?: Array<{ PlanetId?: number | null }>;
      BonusPlanets?: Array<{ PlanetId?: number | null; Bonus?: number | null }>;
    };
    PlanetSimple: {
      PlanetId?: number;
      Name?: string;
    };
  };
}
