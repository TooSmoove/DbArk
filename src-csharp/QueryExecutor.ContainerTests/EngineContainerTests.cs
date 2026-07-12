#nullable enable
using Xunit;

namespace DbArk.Integration;

// Each class binds the shared QueryEngineContainerContract to one engine +
// container. xunit discovers the inherited [Fact] methods, so all four engines
// run the same real-database scenario through the production engine registry.
// IClassFixture starts one container per class (parallelism is disabled
// assembly-wide, so containers come up one at a time).

public sealed class PostgresContainerTests : QueryEngineContainerContract, IClassFixture<PostgresFixture>
{
    private readonly PostgresFixture _fx;
    public PostgresContainerTests(PostgresFixture fx) => _fx = fx;
    protected override string Engine => "postgres";
    protected override IDbContainerFixture Fixture => _fx;
}

public sealed class MySqlContainerTests : QueryEngineContainerContract, IClassFixture<MySqlFixture>
{
    private readonly MySqlFixture _fx;
    public MySqlContainerTests(MySqlFixture fx) => _fx = fx;
    protected override string Engine => "mysql";
    protected override IDbContainerFixture Fixture => _fx;
}

// Proves the wire-compatible MariaDB path really does drive the shared MySQL
// engine implementation against a genuine MariaDB server.
public sealed class MariaDbContainerTests : QueryEngineContainerContract, IClassFixture<MariaDbFixture>
{
    private readonly MariaDbFixture _fx;
    public MariaDbContainerTests(MariaDbFixture fx) => _fx = fx;
    protected override string Engine => "mariadb";
    protected override IDbContainerFixture Fixture => _fx;
}

public sealed class SqlServerContainerTests : QueryEngineContainerContract, IClassFixture<SqlServerFixture>
{
    private readonly SqlServerFixture _fx;
    public SqlServerContainerTests(SqlServerFixture fx) => _fx = fx;
    protected override string Engine => "sqlserver";
    protected override IDbContainerFixture Fixture => _fx;
}

// CockroachDB is wire-compatible with Postgres but uses its own engine
// (SslMode.Disable + Pooling off). This runs the shared contract against a real
// insecure single-node cluster.
public sealed class CockroachDbContainerTests : QueryEngineContainerContract, IClassFixture<CockroachDbFixture>
{
    private readonly CockroachDbFixture _fx;
    public CockroachDbContainerTests(CockroachDbFixture fx) => _fx = fx;
    protected override string Engine => "cockroachdb";
    protected override IDbContainerFixture Fixture => _fx;
}
