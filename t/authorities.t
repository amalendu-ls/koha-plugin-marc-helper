#!/usr/bin/perl
# Koha MARC Helper - headings looked up in the library's own authority file.
# Needs a Koha with authorities (run inside it: koha-shell <instance> -c 'prove t/authorities.t');
# skipped elsewhere. Read only: nothing is added or changed.
use Modern::Perl;
use Test::More;
use FindBin;
use lib "$FindBin::Bin/..";

BEGIN {
    eval { require C4::Context; require C4::Heading; C4::Context->dbh; 1 }
        or plan skip_all => 'Not inside a Koha (C4::Context not available)';
}
use Koha::Plugin::MarcHelper::Authorities;

my $dbh = C4::Context->dbh;
my ($authid) = $dbh->selectrow_array(
    "SELECT authid FROM auth_header WHERE authtypecode = 'TOPIC_TERM' ORDER BY authid LIMIT 1");
plan skip_all => 'This Koha has no subject authorities' unless $authid;

my $auth = Koha::Authorities->find($authid)->record;
my ($main) = $auth->field('150');
my @subs = map { [ $_->[0], $_->[1] ] } $main->subfields;

my $results = Koha::Plugin::MarcHelper::Authorities::check_all([
    { tag => '650', ind1 => ' ', ind2 => '0', subfields => [ map { [ $_->[0], $_->[1] . ( $_ == $subs[-1] ? '.' : '' ) ] } @subs ] },
    { tag => '650', ind1 => ' ', ind2 => '0', subfields => [ [ 'a', 'Qzxw no such heading kmh' ] ] },
    { tag => '245', subfields => [ [ 'a', 'A title' ] ] },
    { tag => '650', subfields => [] },
    { tag => '650', subfields => [ [ 'a', 'x' ] ] },
]);

is scalar @$results, 5, 'one result per heading';
my ($found) = grep { $_->{authid} == $authid } @{ $results->[0]{matches} };
ok $found, "the authority's own heading (with a final full stop) finds authority $authid";
ok $found && $found->{same}, '... and is marked as the same form';
ok $found && defined $found->{usage} && $found->{usage} =~ /^\d+$/, '... with a usage count';
is_deeply $found && $found->{subfields}, [ grep { $_->[0] =~ /^[a-z]$/ } @subs ], '... and the authority subfields to write';
is $results->[0]{type}, 'TOPIC_TERM', 'heading type from Koha (TOPIC_TERM)';
is_deeply $results->[1]{matches}, [], 'an unknown heading: no matches';
like $results->[2]{error}, qr/Not a heading field/, '245 is refused';
like $results->[3]{error}, qr/Empty heading/, 'a heading without subfields is refused';
ok !$results->[4]{error}, 'a short heading is still searched';

my @many = map { { tag => '650', subfields => [ [ 'a', "Topic $_" ] ] } } 1 .. 60;
is scalar @{ Koha::Plugin::MarcHelper::Authorities::check_all( \@many ) }, $Koha::Plugin::MarcHelper::Authorities::MAX_HEADINGS,
    "at most $Koha::Plugin::MarcHelper::Authorities::MAX_HEADINGS headings per request";

done_testing;
